const TIMEOUT_MS = Number(process.env.ASE_RESEARCH_FETCH_TIMEOUT_MS || 6000);
const USER_AGENT = "NovaResearchBot/1.0 (+public company website summary)";
const SAMPLE_ROLES = 8;
const IGNORED_SLUGS = new Set(["embed", "v1", "js", "jobs", "job_board", "api", "widget"]);

const BOARDS = [
    {
        provider: "greenhouse",
        pattern: /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([A-Za-z0-9_-]+)/gi,
        apiUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
        boardUrl: (slug) => `https://boards.greenhouse.io/${slug}`,
        parse: (data) => (data?.jobs || []).map((job) => ({ title: job.title, location: job.location?.name || "", url: job.absolute_url || "" })),
    },
    {
        provider: "lever",
        pattern: /jobs\.lever\.co\/([A-Za-z0-9_-]+)/gi,
        apiUrl: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
        boardUrl: (slug) => `https://jobs.lever.co/${slug}`,
        parse: (data) => (Array.isArray(data) ? data : []).map((job) => ({ title: job.text, location: job.categories?.location || "", department: job.categories?.team || job.categories?.department || "", url: job.hostedUrl || "" })),
    },
    {
        provider: "ashby",
        pattern: /jobs\.ashbyhq\.com\/([A-Za-z0-9_.-]+)/gi,
        apiUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        boardUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
        parse: (data) => (data?.jobs || []).map((job) => ({ title: job.title, location: job.location || "", department: job.department || job.team || "", url: job.jobUrl || "" })),
    },
    {
        provider: "smartrecruiters",
        pattern: /(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/gi,
        apiUrl: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`,
        boardUrl: (slug) => `https://careers.smartrecruiters.com/${slug}`,
        parse: (data) => (data?.content || []).map((job) => ({ title: job.name, location: [job.location?.city, job.location?.country].filter(Boolean).join(", "), department: job.department?.label || "", url: job.ref || "" })),
        total: (data) => (Number.isFinite(data?.totalFound) ? data.totalFound : null),
    },
    {
        provider: "workable",
        pattern: /apply\.workable\.com\/([A-Za-z0-9_-]+)/gi,
        apiUrl: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
        boardUrl: (slug) => `https://apply.workable.com/${slug}`,
        parse: (data) => (data?.jobs || []).map((job) => ({ title: job.title, location: [job.city, job.country].filter(Boolean).join(", "), department: job.department || "", url: job.url || job.shortlink || "" })),
    },
];

const FAMILIES = [
    ["sales", /\b(sales|account executive|business development|bdr|sdr|account manager|partnerships?)\b/i],
    ["customer_success", /\b(customer success|support|customer experience|implementation|onboarding)\b/i],
    ["marketing", /\b(marketing|growth|content|seo|brand|demand gen)\b/i],
    ["engineering", /\b(engineer|developer|sre|devops|architect|qa|sdet|backend|frontend|full[- ]?stack)\b/i],
    ["data", /\b(data|analytics|machine learning|ml|ai scientist)\b/i],
    ["product_design", /\b(product manager|product owner|designer|ux|ui)\b/i],
    ["operations", /\b(operations|supply chain|logistics|procurement)\b/i],
    ["finance_legal", /\b(finance|accountant|legal|counsel|controller|tax)\b/i],
    ["people", /\b(recruit|talent|hr|people)\b/i],
];

export function roleFamily(title) {
    for (const [family, pattern] of FAMILIES) if (pattern.test(String(title || ""))) return family;
    return "other";
}

export function detectJobBoards(sources) {
    const found = new Map();
    for (const text of sources) {
        for (const board of BOARDS) {
            for (const match of String(text || "").matchAll(board.pattern)) {
                const slug = match[1];
                if (!slug || IGNORED_SLUGS.has(slug.toLowerCase())) continue;
                const key = `${board.provider}:${slug.toLowerCase()}`;
                if (!found.has(key)) found.set(key, { board, slug });
            }
        }
    }
    return [...found.values()];
}

async function getJson(url) {
    const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return res.json();
}

export function summarizeRoles(roles) {
    const byFamily = {};
    for (const role of roles) {
        const family = roleFamily(`${role.title} ${role.department || ""}`);
        byFamily[family] = (byFamily[family] || 0) + 1;
    }
    return byFamily;
}

// Reads only job boards the company itself links from its website; slugs are never guessed.
export async function fetchHiringSignals(pages) {
    const sources = (pages || []).flatMap((page) => [...(page.outboundLinks || []), ...(page.jobBoardHints || [])]);
    const boards = detectJobBoards(sources).slice(0, 2);
    for (const { board, slug } of boards) {
        try {
            const data = await getJson(board.apiUrl(slug));
            if (!data) continue;
            const roles = board.parse(data).filter((role) => role.title);
            return {
                provider: board.provider,
                boardUrl: board.boardUrl(slug),
                totalOpenRoles: board.total?.(data) ?? roles.length,
                byFamily: summarizeRoles(roles),
                sampleRoles: roles.slice(0, SAMPLE_ROLES).map(({ title, location, url }) => ({ title, location, url })),
                retrievedAt: new Date().toISOString(),
            };
        } catch {}
    }
    const careersPage = (pages || []).find((page) => page.pageType === "careers");
    return careersPage ? { provider: null, careersPageUrl: careersPage.url, totalOpenRoles: null, retrievedAt: careersPage.retrievedAt } : null;
}

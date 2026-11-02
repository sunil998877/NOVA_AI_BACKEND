import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { detectTechnologies } from "./techDetection.provider.js";

const FETCH_TIMEOUT_MS = Number(process.env.ASE_RESEARCH_FETCH_TIMEOUT_MS || 6000);
const CRAWL_BUDGET_MS = Number(process.env.ASE_RESEARCH_CRAWL_BUDGET_MS || 25000);
const MAX_PAGES = Math.max(1, Number(process.env.ASE_RESEARCH_MAX_PAGES || 10));
const CRAWL_CONCURRENCY = 3;
const CITED_TIMEOUT_MS = Number(process.env.ASE_WEB_SEARCH_FETCH_TIMEOUT_MS || 12000);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_SITEMAP_URLS = 3000;
const USER_AGENT = "NovaResearchBot/1.0 (+public company website summary)";
const ROBOTS_TOKEN = "novaresearchbot";
const HTML_TYPE = /text\/html|application\/xhtml/i;
const TEXT_TYPE = /text\/plain|text\/xml|application\/xml|text\/html/i;

const PAGE_END = String.raw`(\.(html?|php|aspx))?(\/|$)`;
const pageRule = (words) => new RegExp(String.raw`\/(${words})${PAGE_END}`, "i");
const PAGE_RULES = [
    ["pricing", pageRule("pricing|plans|price|prices")],
    ["customers", pageRule("customers?|case-stud(y|ies)|success-stor(y|ies)|testimonials|clients")],
    ["careers", pageRule("careers?|jobs|join-us|work-with-us|hiring")],
    ["team", pageRule("team|leadership|management|founders|our-team")],
    ["about", pageRule("about|about-us|aboutus|company|who-we-are|our-story|ourstory")],
    ["products", pageRule("products?|all-products|solutions?|services|platform|features|what-we-do|offerings")],
    ["press", pageRule("press|newsroom|press-releases|media")],
];
const PAGE_QUOTA = { about: 1, products: 3, pricing: 1, customers: 2, careers: 1, team: 1, press: 1 };
const MAX_DEPTH = { products: 3, customers: 2 };

export function isBlockedAddress(address) {
    const ip = String(address || "").replace(/^::ffff:/i, "");
    if (net.isIP(ip) === 0) return true;
    if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0" || ip === "::") return true;
    if (ip.startsWith("127.") || ip.startsWith("0.")) return true;
    if (ip.startsWith("169.254.") || ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
    if (ip.startsWith("172.")) {
        const second = Number(ip.split(".")[1]);
        if (second >= 16 && second <= 31) return true;
    }
    if (ip.startsWith("100.")) {
        const second = Number(ip.split(".")[1]);
        if (second >= 64 && second <= 127) return true;
    }
    if (net.isIPv4(ip) && Number(ip.split(".")[0]) >= 224) return true;
    const lower = ip.toLowerCase();
    if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) return true;
    return false;
}

// Validates every resolved address at connect time so DNS rebinding cannot reach private networks.
function safeLookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || 4 }];
        const blocked = list.find((a) => isBlockedAddress(a.address));
        if (!list.length || blocked) {
            const error = new Error(`Blocked address for ${hostname}`);
            error.code = "EBLOCKED";
            return callback(error);
        }
        if (options?.all) return callback(null, list);
        return callback(null, list[0].address, list[0].family);
    });
}

function requestOnce(url, acceptType = HTML_TYPE, timeoutMs = FETCH_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) return reject(new Error("Unsupported protocol"));
        if (parsed.port && !["80", "443"].includes(parsed.port)) return reject(new Error("Unsupported port"));
        if (net.isIP(parsed.hostname) && isBlockedAddress(parsed.hostname)) return reject(new Error("Blocked address"));
        const client = parsed.protocol === "https:" ? https : http;
        const req = client.get(url, {
            lookup: safeLookup,
            timeout: timeoutMs,
            headers: {
                "User-Agent": USER_AGENT,
                Accept: acceptType === HTML_TYPE ? "text/html,application/xhtml+xml" : "text/plain,application/xml,text/xml,*/*;q=0.5",
                "Accept-Encoding": "gzip, deflate, br",
            },
        }, (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                return resolve({ redirect: new URL(res.headers.location, url).toString(), status });
            }
            const type = String(res.headers["content-type"] || "");
            if (status !== 200 || (type && !acceptType.test(type))) {
                res.resume();
                return resolve({ status, body: null });
            }
            const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
            const decoder = encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip()
                : encoding === "br" ? zlib.createBrotliDecompress()
                : encoding === "deflate" ? zlib.createInflate()
                : null;
            const stream = decoder ? res.pipe(decoder) : res;
            const chunks = [];
            let size = 0;
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve({ status, body: Buffer.concat(chunks).toString("utf8"), url });
            };
            stream.on("data", (chunk) => {
                if (size >= MAX_BYTES) return;
                size += chunk.length;
                chunks.push(chunk);
                if (size >= MAX_BYTES) {
                    finish();
                    req.destroy();
                }
            });
            stream.on("end", finish);
            stream.on("close", finish);
            stream.on("error", finish);
        });
        req.on("timeout", () => req.destroy(new Error("Fetch timeout")));
        req.on("error", reject);
    });
}

async function fetchWithRedirects(url, acceptType, timeoutMs) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const res = await requestOnce(current, acceptType, timeoutMs);
        if (res.redirect) {
            current = res.redirect;
            continue;
        }
        return res.body ? { url: res.url || current, body: res.body } : null;
    }
    return null;
}

export async function fetchHtml(url, { timeoutMs } = {}) {
    const res = await fetchWithRedirects(url, HTML_TYPE, timeoutMs);
    return res ? { url: res.url, html: res.body } : null;
}

async function fetchText(url) {
    try {
        const res = await fetchWithRedirects(url, TEXT_TYPE);
        return res?.body || null;
    } catch {
        return null;
    }
}

function patternToRegex(pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped.endsWith("\\$") ? `${escaped.slice(0, -2)}$` : escaped}`);
}

export function parseRobots(text, token = ROBOTS_TOKEN) {
    const groups = [];
    let current = null;
    let lastWasAgent = false;
    const sitemaps = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, "").trim();
        const idx = line.indexOf(":");
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (key === "user-agent") {
            if (!lastWasAgent || !current) {
                current = { agents: [], rules: [] };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
            continue;
        }
        lastWasAgent = false;
        if (key === "sitemap" && value) sitemaps.push(value);
        if (!current || (key !== "allow" && key !== "disallow")) continue;
        if (key === "disallow" && !value) continue;
        current.rules.push({ allow: key === "allow", path: value, regex: patternToRegex(value) });
    }
    const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
    const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
    const rules = chosen.flatMap((g) => g.rules);
    return {
        sitemaps,
        isAllowed(pathname) {
            let best = null;
            for (const rule of rules) {
                if (!rule.regex.test(pathname)) continue;
                if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
            }
            return !best || best.allow;
        },
    };
}

export function classifyPage(url) {
    try {
        const { pathname } = new URL(url);
        for (const [type, pattern] of PAGE_RULES) {
            if (!pattern.test(pathname)) continue;
            const depth = pathname.split("/").filter(Boolean).length;
            if (depth > (MAX_DEPTH[type] || 2) + 1) return null;
            return type;
        }
    } catch {}
    return null;
}

function sameSite(a, b) {
    return a.replace(/^www\./, "") === b.replace(/^www\./, "");
}

function normalizeLink(href, base) {
    try {
        const link = new URL(href, base);
        if (!["http:", "https:"].includes(link.protocol) || !sameSite(link.hostname, base.hostname)) return null;
        if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|xml|json|css|js)$/i.test(link.pathname)) return null;
        return `${link.origin}${link.pathname}`.replace(/^http:/, "https:");
    } catch {
        return null;
    }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decode(text) {
    return String(text || "")
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, code) => {
            if (code[0] === "#") {
                const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
                return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
            }
            return ENTITIES[code.toLowerCase()] ?? match;
        })
        .replace(/\s+/g, " ")
        .trim();
}

function metaContent(html, attr, value) {
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
        const key = tag.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, "i"));
        if (key && key[1].toLowerCase() === value) {
            const content = tag.match(/content\s*=\s*["']([^"']*)["']/i);
            if (content) return decode(content[1]);
        }
    }
    return "";
}

function textOf(fragment) {
    return decode(String(fragment || "").replace(/<[^>]+>/g, " "));
}

export function extractPageFacts(html, url) {
    const source = String(html || "");
    const body = source
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ");
    const content = body.replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, " ");
    const title = decode((source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").slice(0, 200);
    const description = (metaContent(source, "name", "description") || metaContent(source, "property", "og:description")).slice(0, 400);
    const siteName = metaContent(source, "property", "og:site_name").slice(0, 120);
    const headings = [...content.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
        .map((m) => textOf(m[1]))
        .filter((h) => h.length >= 3 && h.length <= 160)
        .slice(0, 10);
    const paragraphs = [...content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((m) => textOf(m[1]))
        .filter((p) => p.length >= 60)
        .slice(0, 8);
    const listItems = [...new Set([...content.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
        .map((m) => textOf(m[1]))
        .filter((item) => item.length >= 20 && item.length <= 160))]
        .slice(0, 12);
    const base = new URL(url);
    const anchors = [...source.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]);
    const internal = [...new Set(anchors.map((href) => normalizeLink(href, base)).filter(Boolean))];
    return {
        url,
        title,
        description,
        siteName,
        headings,
        listItems,
        excerpt: paragraphs.join(" ").slice(0, 2000),
        links: internal.filter((link) => classifyPage(link)),
        outboundLinks: [...new Set(anchors.filter((href) => /^https?:\/\//i.test(href)))].slice(0, 200),
        jobBoardHints: [...new Set(source.match(/[a-z.-]*(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com)\/[^"'\s<>]{1,120}/gi) || [])].slice(0, 20),
        technologies: detectTechnologies(source, url),
        loginForm: /<input\b[^>]*type\s*=\s*["']?password/i.test(source),
        retrievedAt: new Date().toISOString(),
    };
}

const PLACEHOLDER_TITLE = /\b(sogo|roundcube|zimbra web client|squirrelmail|horde|outlook web app|webmail|e-?mail system|mail server|cpanel|plesk|index of \/|default (web site |server )?page|welcome to nginx|it works!|domain (is )?for sale|parked domain|this domain is parked|coming soon|under construction|account suspended|site not found)\b/i;

// A webmail login, parked domain or default server page says nothing about the company's business.
export function isPlaceholderPage(page) {
    if (!page) return true;
    if ((page.links || []).length >= 3) return false;
    if (PLACEHOLDER_TITLE.test(`${page.title || ""} | ${page.description || ""}`)) return true;
    return Boolean(page.loginForm && String(page.excerpt || "").length < 400);
}

export function sitemapLocs(body) {
    const text = String(body || "");
    const locs = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]));
    if (locs.length || /<(urlset|sitemapindex)/i.test(text)) return locs;
    return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^https?:\/\/\S+$/i.test(line));
}

async function loadSitemapUrls(origin, robots, deadline) {
    const roots = robots.sitemaps.length ? robots.sitemaps.slice(0, 2) : [`${origin}/sitemap.xml`];
    const urls = [];
    for (const root of roots) {
        if (Date.now() > deadline || urls.length >= MAX_SITEMAP_URLS) break;
        if (/\.gz$/i.test(root)) continue;
        const xml = await fetchText(root);
        if (!xml) continue;
        if (/<sitemapindex/i.test(xml)) {
            const children = sitemapLocs(xml)
                .filter((loc) => !/\.gz$/i.test(loc) && !/(product|post|blog|tag|author|categor|image|video)/i.test(loc))
                .slice(0, 3);
            for (const child of children) {
                if (Date.now() > deadline || urls.length >= MAX_SITEMAP_URLS) break;
                urls.push(...sitemapLocs(await fetchText(child)).slice(0, MAX_SITEMAP_URLS - urls.length));
            }
        } else {
            urls.push(...sitemapLocs(xml).slice(0, MAX_SITEMAP_URLS - urls.length));
        }
    }
    return urls;
}

export function planCrawl(candidates, homeUrl, maxPages = MAX_PAGES) {
    const home = new URL(homeUrl);
    const byType = new Map();
    for (const raw of candidates) {
        const link = normalizeLink(raw, home);
        if (!link || link.replace(/\/$/, "") === `${home.origin}${home.pathname}`.replace(/\/$/, "")) continue;
        const type = classifyPage(link);
        if (!type) continue;
        if (!byType.has(type)) byType.set(type, new Set());
        byType.get(type).add(link);
    }
    const plan = [];
    for (const [type, quota] of Object.entries(PAGE_QUOTA)) {
        const links = [...(byType.get(type) || [])].sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
        for (const url of links.slice(0, quota)) plan.push({ url, pageType: type });
    }
    return plan.slice(0, Math.max(0, maxPages - 1));
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]).catch(() => null);
        }
    });
    await Promise.all(workers);
    return results;
}

export function htmlToText(html) {
    return textOf(String(html || "")
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n"));
}

// Fetches one third-party page (e.g. a news article) for quote verification, honoring its robots.txt.
export async function fetchCitedPage(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const robots = parseRobots(await fetchText(`${parsed.origin}/robots.txt`));
    if (!robots.isAllowed(parsed.pathname)) return { url, blocked: "ROBOTS_DISALLOWED" };
    let res = await fetchHtml(parsed.toString(), { timeoutMs: CITED_TIMEOUT_MS }).catch(() => null);
    if (!res?.html) res = await fetchHtml(parsed.toString(), { timeoutMs: CITED_TIMEOUT_MS }).catch(() => null);
    if (!res?.html) return { url, blocked: "FETCH_FAILED" };
    const title = decode((res.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").slice(0, 200);
    return { url: res.url, title, text: htmlToText(res.html).slice(0, 200000), retrievedAt: new Date().toISOString() };
}

export async function fetchCompanySite(domain, { acceptHome = null } = {}) {
    if (!domain) return [];
    const deadline = Date.now() + CRAWL_BUDGET_MS;
    let home = null;
    let origin = null;
    for (const candidate of [`https://${domain}`, `https://www.${domain}`, `https://www.${domain}`]) {
        if (Date.now() > deadline) break;
        try {
            const res = await fetchHtml(candidate);
            if (res?.html) {
                home = extractPageFacts(res.html, res.url);
                origin = new URL(res.url).origin;
                break;
            }
        } catch {}
    }
    if (!home || (!home.title && !home.description && !home.excerpt) || isPlaceholderPage(home)) return [];
    if (acceptHome && !acceptHome(home)) return [];

    const robots = parseRobots(await fetchText(`${origin}/robots.txt`));
    if (!robots.isAllowed(new URL(home.url).pathname)) return [];
    home.pageType = "home";

    const sitemapUrls = Date.now() < deadline ? await loadSitemapUrls(origin, robots, deadline) : [];
    const plan = planCrawl([...home.links, ...sitemapUrls], home.url)
        .filter((item) => robots.isAllowed(new URL(item.url).pathname));

    const pages = await mapLimit(plan, CRAWL_CONCURRENCY, async (item) => {
        if (Date.now() > deadline) return null;
        const res = await fetchHtml(item.url);
        if (!res?.html) return null;
        const page = extractPageFacts(res.html, res.url);
        return { ...page, pageType: item.pageType };
    });
    return [home, ...pages.filter(Boolean)].map(({ links, ...page }) => page);
}

import { getOpenAiClient } from "../../controllers/OpenAI/client.js";

const PUBLIC_DOMAINS = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com"]);
const CACHE_MS = 6 * 60 * 60 * 1000;
const researchCache = new Map();
const researchInflight = new Map();

function cleanDomain(domain) {
    if (!domain) return null;
    const clean = String(domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!clean || PUBLIC_DOMAINS.has(clean)) return null;
    return clean;
}

function cacheKey(domain, companyName) {
    return cleanDomain(domain) || `name:${String(companyName || "").trim().toLowerCase()}`;
}

export function peekCompanyResearch(domain, companyName = "") {
    const key = cacheKey(domain, companyName);
    const hit = researchCache.get(key);
    if (!hit || hit.expires <= Date.now()) return null;
    return hit.research;
}

export function rememberCompanyResearch(domain, companyName, research) {
    if (!research?.summary) return;
    researchCache.set(cacheKey(domain, companyName), {
        expires: Date.now() + CACHE_MS,
        research,
    });
}

async function fetchWebsiteMetadata(domain) {
    const clean = cleanDomain(domain);
    if (!clean) return null;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`https://${clean}`, {
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        });
        clearTimeout(timeout);
        if (!res.ok) return null;
        const html = await res.text();
        const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
        const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)
            || html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
        return {
            title: titleMatch ? titleMatch[1].trim() : "",
            description: descMatch ? descMatch[1].trim() : "",
        };
    } catch {
        return null;
    }
}

export async function loadCompanyContext(companyName, { domain = null, leadInfo = {} } = {}) {
    if (leadInfo?.metadata?.company_research?.summary) {
        return {
            cachedResearch: leadInfo.metadata.company_research,
            effectiveCompany: leadInfo.metadata.company_research.company || companyName,
            effectiveDomain: cleanDomain(domain),
            siteData: null,
        };
    }

    const rawCompany = String(companyName || "").trim();
    let effectiveDomain = cleanDomain(domain) || cleanDomain(leadInfo?.email?.split("@")[1]);
    let siteData = null;

    if (!effectiveDomain && rawCompany) {
        const guessed = `${rawCompany.toLowerCase().replace(/[^a-z0-9]/g, "")}.com`;
        siteData = await fetchWebsiteMetadata(guessed);
        if (siteData) effectiveDomain = guessed;
    } else if (effectiveDomain) {
        siteData = await fetchWebsiteMetadata(effectiveDomain);
    }

    const effectiveCompany = rawCompany || (effectiveDomain ? effectiveDomain.split(".")[0] : "Target Organization");
    return {
        cachedResearch: peekCompanyResearch(effectiveDomain, effectiveCompany),
        effectiveCompany,
        effectiveDomain,
        siteData,
        industryHint: leadInfo.industry || leadInfo.title || "",
    };
}

function heuristicResearch(context) {
    const company = context.effectiveCompany;
    return {
        company,
        summary: context.siteData?.description || `${company} delivers technology solutions, software services, and digital products to clients.`,
        coreServices: context.siteData?.title || "Technology, software development, and specialized services",
        industry: context.industryHint || "Software & Technology Services",
        targetAudience: "Businesses and enterprise clients",
        growthOpportunity: `A practical conversation about how ${company} reaches the customers it already serves`,
        source: context.siteData ? "website_scrape" : "rule_heuristics",
    };
}

async function researchUncached(context) {
    const client = getOpenAiClient();
    if (client) {
        try {
            const response = await client.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are an expert B2B business analyst. Output valid JSON." },
                    { role: "user", content: `Summarize this company from the website signals.\nCompany: ${context.effectiveCompany}\nDomain: ${context.effectiveDomain || "unknown"}\nTitle: ${context.siteData?.title || "N/A"}\nDescription: ${context.siteData?.description || "N/A"}\nReturn JSON with summary, coreServices, industry, targetAudience, growthOpportunity.` },
                ],
                response_format: { type: "json_object" },
                temperature: 0.4,
            });
            const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
            if (parsed.summary) {
                return {
                    company: context.effectiveCompany,
                    summary: parsed.summary,
                    coreServices: parsed.coreServices || "",
                    industry: parsed.industry || context.industryHint || "Software & Technology Solutions",
                    targetAudience: parsed.targetAudience || "Enterprises & SMBs",
                    growthOpportunity: parsed.growthOpportunity || `A practical conversation about how ${context.effectiveCompany} reaches its customers`,
                    source: "ai_intelligence",
                };
            }
        } catch {}
    }
    return heuristicResearch(context);
}

export async function researchCompany(companyName, options = {}) {
    const context = await loadCompanyContext(companyName, options);
    if (context.cachedResearch) return context.cachedResearch;

    const key = cacheKey(context.effectiveDomain, context.effectiveCompany);
    if (researchInflight.has(key)) return researchInflight.get(key);

    const job = researchUncached(context)
        .then((research) => {
            rememberCompanyResearch(context.effectiveDomain, context.effectiveCompany, research);
            return research;
        })
        .finally(() => researchInflight.delete(key));

    researchInflight.set(key, job);
    return job;
}

export { heuristicResearch };

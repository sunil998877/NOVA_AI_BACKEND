import OpenAI from "openai";
import { env } from "../../config/env.js";
import { getOpenAiClient } from "../../controllers/OpenAI/client.js";
import { getCachedResearch, setCachedResearch } from "../queue/cache.service.js";
import { fetchCompanySite, isBlockedAddress } from "./companyWebsite.service.js";

function getResearchOpenAiClient() {
    const apiKey = String(env.openaiApiKey || "").trim();
    if (!apiKey) return null;
    return getOpenAiClient() || new OpenAI({
        apiKey,
        timeout: env.openaiTimeoutMs || 45000,
        maxRetries: 2,
    });
}

const PUBLIC_DOMAINS = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "live.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);
const PLACEHOLDER_DOMAINS = new Set([
    "example.com",
    "example.net",
    "example.org",
    "example.edu",
    "test.com",
    "test.net",
    "invalid.com",
    "localhost.com",
    "email.com",
    "domain.com",
]);
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata.google.com", "169.254.169.254"]);
const CACHE_MS = Number(process.env.ASE_RESEARCH_CACHE_TTL_HOURS || 6) * 60 * 60 * 1000;
const researchCache = new Map();
const researchInflight = new Map();

function cleanDomain(domain) {
    if (!domain) return null;
    const clean = String(domain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
    if (!clean || PUBLIC_DOMAINS.has(clean) || PLACEHOLDER_DOMAINS.has(clean) || BLOCKED_HOSTS.has(clean)) return null;
    if (clean.endsWith(".example") || clean.endsWith(".test") || clean.endsWith(".invalid") || clean.endsWith(".localhost")) return null;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean)) return null;
    return clean;
}

export function isUsableResearchProfile(research) {
    if (!research || typeof research !== "object") return false;
    const domain = cleanDomain(research.domain);
    if (research.domain && !domain) return false;
    if (/example domain/i.test(String(research.summary || ""))) return false;
    const summary = String(research.summary || "").trim();
    if (!summary) return false;
    if (research.qualityStatus === "INSUFFICIENT_EVIDENCE") return false;
    if (research.source === "lead_record" || research.source === "openai_key_missing") return false;
    return true;
}

function cacheKey(domain, companyName) {
    return cleanDomain(domain) || `name:${String(companyName || "").trim().toLowerCase()}`;
}

function scoreResearch({ domain, effectiveDomain, sitePages }) {
    const pages = sitePages || [];
    const resolvedDomain = domain || effectiveDomain;
    const hasTitle = pages.some((page) => page.title);
    const hasDescription = pages.some((page) => page.description);
    const reasons = [];
    if (resolvedDomain) reasons.push("DOMAIN_RESOLVED");
    else reasons.push("DOMAIN_UNRESOLVED");
    if (hasTitle) reasons.push("SOURCE_TITLE");
    if (hasDescription) reasons.push("SOURCE_DESCRIPTION");
    if (pages.length > 1) reasons.push("MULTIPLE_PAGES");
    if (!resolvedDomain) return { qualityStatus: "INSUFFICIENT_EVIDENCE", qualityReasons: reasons };
    if (hasTitle && hasDescription) return { qualityStatus: pages.length > 1 ? "HIGH_CONFIDENCE" : "ACCEPTABLE", qualityReasons: reasons };
    if (hasTitle || hasDescription) return { qualityStatus: "PARTIAL_RESEARCH", qualityReasons: reasons };
    return { qualityStatus: "INSUFFICIENT_EVIDENCE", qualityReasons: reasons };
}

function buildProfile(context, extras = {}) {
    const quality = extras.qualityStatus
        ? { qualityStatus: extras.qualityStatus, qualityReasons: extras.qualityReasons || ["OPENAI_COMPANY_LOOKUP"] }
        : scoreResearch(context);
    const pages = context.sitePages || (context.siteData ? [context.siteData] : []);
    const primary = pages[0] || {};
    const sources = [
        ...pages.filter((page) => page.url).map((page) => ({
            url: page.url,
            title: page.title || "",
            retrievedAt: page.retrievedAt || new Date().toISOString(),
            excerpt: (page.description || page.excerpt || page.title || "").slice(0, 240),
        })),
    ];
    const facts = [];
    if (primary.title) {
        facts.push({
            field: "pageTitle",
            value: primary.title,
            sourceUrl: primary.url || null,
            verificationStatus: "verified",
            evidenceExcerpt: primary.title,
        });
    }
    for (const page of pages) {
        if (!page.description) continue;
        facts.push({
            field: page === primary ? "overview" : "pageOverview",
            value: page.description,
            sourceUrl: page.url || null,
            verificationStatus: "verified",
            evidenceExcerpt: page.description.slice(0, 240),
        });
    }
    const summary = extras.summary || primary.description || (primary.title
        ? `${context.effectiveCompany} public site title: ${primary.title}.`
        : null);
    return {
        company: context.effectiveCompany,
        domain: context.effectiveDomain || null,
        summary,
        coreServices: extras.coreServices || "",
        industry: extras.industry || context.industryHint || "",
        targetAudience: extras.targetAudience || "",
        growthOpportunity: extras.growthOpportunity || "",
        source: extras.source || (sources.length ? "website_scrape" : "lead_record"),
        sources,
        facts,
        qualityStatus: quality.qualityStatus,
        qualityReasons: quality.qualityReasons,
        profileVersion: 1,
        researchedAt: new Date().toISOString(),
        resolutionMethod: context.effectiveDomain ? "email_or_website_domain" : "company_name_only",
        resolutionConfidence: context.effectiveDomain ? 0.8 : 0.2,
    };
}

export function peekCompanyResearch(domain, companyName = "") {
    const key = cacheKey(domain, companyName);
    const hit = researchCache.get(key);
    if (!hit || hit.expires <= Date.now()) return null;
    if (!isUsableResearchProfile(hit.research)) return null;
    return hit.research;
}

export function rememberCompanyResearch(domain, companyName, research) {
    if (!isUsableResearchProfile(research)) return;
    researchCache.set(cacheKey(domain, companyName), {
        expires: Date.now() + CACHE_MS,
        research,
    });
    const normalized = cleanDomain(domain);
    if (normalized) {
        setCachedResearch(normalized, research).catch(() => {});
    }
}

export async function loadCompanyContext(companyName, { domain = null, leadInfo = {} } = {}) {
    if (isUsableResearchProfile(leadInfo?.metadata?.company_research)) {
        return {
            cachedResearch: leadInfo.metadata.company_research,
            effectiveCompany: leadInfo.metadata.company_research.company || companyName,
            effectiveDomain: cleanDomain(domain),
            siteData: null,
            sitePages: [],
        };
    }

    const rawCompany = String(companyName || "").trim();
    const effectiveDomain = cleanDomain(domain)
        || cleanDomain(leadInfo?.website)
        || cleanDomain(leadInfo?.company_website)
        || cleanDomain(leadInfo?.email?.split("@")[1]);
    const effectiveCompany = rawCompany || (effectiveDomain ? effectiveDomain.split(".")[0] : "Unknown organization");
    let cachedResearch = peekCompanyResearch(effectiveDomain, effectiveCompany);
    if (!cachedResearch && effectiveDomain) {
        cachedResearch = await getCachedResearch(effectiveDomain);
        if (cachedResearch) {
            rememberCompanyResearch(effectiveDomain, effectiveCompany, cachedResearch);
        }
    }
    return {
        cachedResearch,
        effectiveCompany,
        effectiveDomain,
        siteData: null,
        sitePages: [],
        industryHint: leadInfo.industry || "",
        roleHint: leadInfo.title || leadInfo.segment_attributes?.title || "",
        resolutionMethod: effectiveDomain ? "email_or_website_domain" : "company_name_only",
    };
}

function heuristicResearch(context) {
    return buildProfile(context);
}

async function lookupCompanyWithOpenAi(context) {
    const client = getResearchOpenAiClient();
    if (!context.effectiveCompany) return null;
    if (!client) {
        console.error("[CompanyResearch] OPENAI_API_KEY is missing; company lookup skipped");
        return buildProfile(context, {
            source: "openai_key_missing",
            qualityStatus: "INSUFFICIENT_EVIDENCE",
            qualityReasons: ["OPENAI_KEY_MISSING"],
        });
    }
    const response = await client.chat.completions.create({
        model: process.env.ASE_RESEARCH_MODEL || "gpt-4o-mini",
        messages: [
            {
                role: "system",
                content: "Identify what kind of company this is using only the company name, role, industry hint, and email domain. Always fill summary with two sentences. If you recognize the company, describe what it actually does. If you do not recognize it, infer only from the name words and set knownCompany to false. Never invent revenue, customers, funding, news, headquarters, or a website URL. Never return an empty summary. Output valid JSON.",
            },
            {
                role: "user",
                content: `Company name: ${context.effectiveCompany}
Role: ${context.roleHint || "unknown"}
Industry hint: ${context.industryHint || "unknown"}
Email or website domain: ${context.effectiveDomain || "none"}

Return JSON:
{
  "knownCompany": true,
  "summary": "2 sentences on what the company does",
  "industry": "industry",
  "coreServices": "main offerings",
  "targetAudience": "who they sell to",
  "growthOpportunity": "one relevant outreach angle"
}`,
            },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    const industry = String(parsed.industry || context.industryHint || "").trim();
    const coreServices = String(parsed.coreServices || "").trim();
    let summary = String(parsed.summary || "").trim();
    if (!summary && (coreServices || industry)) {
        summary = `${context.effectiveCompany} appears to operate in ${industry || "its market"}. ${coreServices || "Public offerings were inferred from the company name."}`;
    }
    if (!summary) return null;
    return buildProfile(context, {
        summary,
        coreServices,
        industry,
        targetAudience: parsed.targetAudience || "",
        growthOpportunity: parsed.growthOpportunity || "",
        source: "openai_company_lookup",
        qualityStatus: parsed.knownCompany ? "PARTIAL_RESEARCH" : "NEEDS_REVIEW",
        qualityReasons: parsed.knownCompany ? ["OPENAI_KNOWN_COMPANY"] : ["OPENAI_NAME_INFERENCE"],
    });
}

async function summarizeSiteWithOpenAi(context) {
    const client = getResearchOpenAiClient();
    if (!client) return null;
    const corpus = context.sitePages.map((page) => [
        `URL: ${page.url}`,
        page.title && `Title: ${page.title}`,
        page.description && `Description: ${page.description}`,
        page.headings?.length && `Headings: ${page.headings.join(" | ")}`,
        page.excerpt && `Text: ${page.excerpt}`,
    ].filter(Boolean).join("\n")).join("\n\n").slice(0, 6000);
    const response = await client.chat.completions.create({
        model: process.env.ASE_RESEARCH_MODEL || "gpt-4o-mini",
        messages: [
            {
                role: "system",
                content: "Summarize a company strictly from the website text provided. Use only statements present in the text. If a field is not supported by the text, return an empty string for it. Never add customers, revenue, funding, locations, news, or claims that are not in the text. Output valid JSON.",
            },
            {
                role: "user",
                content: `Company: ${context.effectiveCompany}\n\nWebsite text:\n${corpus}\n\nReturn JSON: {"summary": "1-2 sentences on what the company does", "industry": "", "coreServices": "", "targetAudience": ""}`,
            },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    const pick = (value) => String(value || "").trim().slice(0, 400);
    return {
        summary: pick(parsed.summary) || null,
        industry: pick(parsed.industry),
        coreServices: pick(parsed.coreServices),
        targetAudience: pick(parsed.targetAudience),
    };
}

async function researchFromWebsite(context) {
    if (!context.effectiveDomain || process.env.ASE_RESEARCH_FETCH_SITE === "false") return null;
    const sitePages = await fetchCompanySite(context.effectiveDomain).catch(() => []);
    if (!sitePages.length) return null;
    const siteContext = { ...context, sitePages };
    const summarized = await summarizeSiteWithOpenAi(siteContext).catch((error) => {
        console.warn("[CompanyResearch] Website summary failed:", error.message);
        return null;
    });
    return buildProfile(siteContext, { ...(summarized || {}), source: "website_scrape" });
}

async function researchUncached(context) {
    try {
        const fromSite = await researchFromWebsite(context);
        if (fromSite && fromSite.qualityStatus !== "INSUFFICIENT_EVIDENCE") return fromSite;
    } catch (error) {
        console.warn("[CompanyResearch] Website research failed:", error.message);
    }
    try {
        const researched = await lookupCompanyWithOpenAi(context);
        if (researched) return researched;
    } catch (error) {
        console.error("[CompanyResearch] OpenAI company lookup failed:", error.message);
    }
    return heuristicResearch(context);
}

export function isCompanyResearchPending(lead) {
    let meta = lead?.metadata;
    if (typeof meta === "string") {
        try {
            meta = JSON.parse(meta);
        } catch {
            meta = {};
        }
    }
    if (!meta || typeof meta !== "object") meta = {};
    if (lead?.company && !isUsableResearchProfile(meta.company_research)) return true;
    if (isUsableResearchProfile(meta.company_research) && !meta.outreach_email?.subject) return true;
    return false;
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

export { heuristicResearch, cleanDomain, isBlockedAddress };

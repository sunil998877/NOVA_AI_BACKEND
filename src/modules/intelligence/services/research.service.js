import OpenAI from "openai";
import { env } from "../../../config/env.js";
import { getOpenAiClient } from "../../../controllers/OpenAI/client.js";
import { getCachedResearch, setCachedResearch } from "../../../services/queue/cache.service.js";
import { fetchCompanySite, isBlockedAddress } from "../providers/website.provider.js";
import { findOfficialWebsite, findReferencePage } from "../providers/wikipedia.provider.js";
import { mergeTechnologies } from "../providers/techDetection.provider.js";
import { fetchHiringSignals } from "../providers/hiring.provider.js";
import { searchCompanyEvents } from "../providers/webSearch.provider.js";
import { extractVerifiedFacts } from "./extraction.service.js";

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

export function resolveResearchDomain({ domain, website, email, company } = {}) {
    return cleanDomain(domain)
        || cleanDomain(website)
        || cleanDomain(String(email || "").split("@")[1])
        || cleanDomain(String(company || "").trim().toLowerCase().replace(/\s+/g, ""));
}

export function isUsableResearchProfile(research) {
    if (!research || typeof research !== "object") return false;
    const domain = cleanDomain(research.domain);
    if (research.domain && !domain) return false;
    if (/example domain/i.test(String(research.summary || ""))) return false;
    const summary = String(research.summary || "").trim();
    if (!summary) return false;
    if (/no verified public source was found/i.test(summary)) return false;
    if (research.qualityStatus === "INSUFFICIENT_EVIDENCE" || research.qualityStatus === "NEEDS_REVIEW") return false;
    if (research.source === "lead_record" || research.source === "openai_key_missing" || research.source === "openai_company_lookup") return false;
    return true;
}

const GROUNDED_QUALITY = new Set(["HIGH_CONFIDENCE", "ACCEPTABLE", "PARTIAL_RESEARCH"]);
const UNGROUNDED_SOURCES = new Set(["openai_company_lookup", "lead_record", "openai_key_missing"]);

// Only website-sourced research may be stated to a prospect as fact; model recall is never evidence.
export function isGroundedResearch(research) {
    if (!isUsableResearchProfile(research)) return false;
    if (UNGROUNDED_SOURCES.has(research.source)) return false;
    const hasSources = Array.isArray(research.sources) && research.sources.some((s) => s?.url);
    return hasSources && GROUNDED_QUALITY.has(String(research.qualityStatus || "").toUpperCase());
}

function cacheKey(domain, companyName, orgId) {
    const subject = cleanDomain(domain) || `name:${String(companyName || "").trim().toLowerCase()}`;
    return `${Number(orgId) || 0}:${subject}`;
}

function resolveOrgId(options = {}) {
    return Number(options.organizationId || options.leadInfo?.organization_id) || 0;
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
            pageType: page.pageType || null,
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
    facts.push(...(extras.facts || []));
    if (extras.facts?.length) quality.qualityReasons = [...quality.qualityReasons, "EXTRACTED_VERIFIED_FACTS"];
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
        ...(extras.unverifiedHypothesis ? { unverifiedHypothesis: extras.unverifiedHypothesis } : {}),
        source: extras.source || (sources.length ? "website_scrape" : "lead_record"),
        sources,
        facts,
        technologies: extras.technologies || [],
        hiring: extras.hiring || null,
        ...(extras.rejectedFacts?.length ? { rejectedFacts: extras.rejectedFacts } : {}),
        qualityStatus: quality.qualityStatus,
        qualityReasons: quality.qualityReasons,
        profileVersion: 2,
        researchedAt: new Date().toISOString(),
        resolutionMethod: context.resolutionMethod && context.effectiveDomain
            ? context.resolutionMethod
            : (context.effectiveDomain ? "email_or_website_domain" : "company_name_only"),
        resolutionConfidence: context.effectiveDomain
            ? (String(context.resolutionMethod || "").startsWith("discovered") ? 0.7 : 0.8)
            : 0.2,
    };
}

export function peekCompanyResearch(domain, companyName = "", orgId = 0) {
    const key = cacheKey(domain, companyName, orgId);
    const hit = researchCache.get(key);
    if (!hit || hit.expires <= Date.now()) return null;
    if (!isGroundedResearch(hit.research)) return null;
    return hit.research;
}

export function rememberCompanyResearch(domain, companyName, research, orgId = 0) {
    if (!isGroundedResearch(research)) return;
    researchCache.set(cacheKey(domain, companyName, orgId), {
        expires: Date.now() + CACHE_MS,
        research,
    });
    const normalized = cleanDomain(domain);
    if (normalized && orgId) {
        setCachedResearch(normalized, research, orgId).catch(() => {});
    }
}

export async function loadCompanyContext(companyName, { domain = null, leadInfo = {}, organizationId = null } = {}) {
    const orgId = resolveOrgId({ organizationId, leadInfo });
    if (isUsableResearchProfile(leadInfo?.metadata?.company_research)) {
        return {
            orgId,
            cachedResearch: leadInfo.metadata.company_research,
            effectiveCompany: leadInfo.metadata.company_research.company || companyName,
            effectiveDomain: cleanDomain(domain),
            siteData: null,
            sitePages: [],
        };
    }

    const rawCompany = String(companyName || "").trim();
    const effectiveDomain = resolveResearchDomain({
        domain,
        website: leadInfo?.website || leadInfo?.company_website,
        email: leadInfo?.email,
        company: rawCompany,
    });
    const effectiveCompany = rawCompany || (effectiveDomain ? effectiveDomain.split(".")[0] : "Unknown organization");
    let cachedResearch = peekCompanyResearch(effectiveDomain, effectiveCompany, orgId);
    if (!cachedResearch && effectiveDomain && orgId) {
        cachedResearch = await getCachedResearch(effectiveDomain, orgId);
        if (!isGroundedResearch(cachedResearch)) cachedResearch = null;
        if (cachedResearch) {
            rememberCompanyResearch(effectiveDomain, effectiveCompany, cachedResearch, orgId);
        }
    }
    return {
        orgId,
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
        summary: "",
        coreServices: "",
        industry: context.industryHint || "",
        unverifiedHypothesis: {
            summary,
            industry,
            coreServices,
            knownCompany: Boolean(parsed.knownCompany),
        },
        source: "openai_company_lookup",
        qualityStatus: "NEEDS_REVIEW",
        qualityReasons: [parsed.knownCompany ? "OPENAI_KNOWN_COMPANY" : "OPENAI_NAME_INFERENCE", "NO_SOURCE_EVIDENCE"],
        evidenceBacked: false,
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

const GENERIC_NAME_WORDS = new Set([
    "inc", "incorporated", "llc", "ltd", "limited", "pvt", "private", "corp", "corporation", "co", "company",
    "gmbh", "plc", "llp", "the", "and", "group", "technologies", "technology", "tech", "solutions", "software",
    "services", "systems", "labs", "global", "india", "international", "enterprises", "industries",
]);

export function companyCoreTokens(company) {
    const words = String(company || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const core = words.filter((word) => word.length >= 2 && !GENERIC_NAME_WORDS.has(word));
    return core.length ? core : words.filter((word) => word.length >= 2);
}

// The fetched homepage must name the brand in its title, site name, top heading, or host.
export function siteMatchesCompany(company, home, domain = "") {
    const [brand] = companyCoreTokens(company);
    if (!brand) return false;
    const squash = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    let host = domain;
    try {
        host = new URL(home?.url || "").hostname || domain;
    } catch {}
    const haystack = squash([home?.title, home?.siteName, home?.headings?.[0], host].join(" "));
    return haystack.includes(brand);
}

async function suggestDomainsWithOpenAi(context) {
    const client = getResearchOpenAiClient();
    if (!client) return [];
    const response = await client.chat.completions.create({
        model: process.env.ASE_RESEARCH_MODEL || "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
            {
                role: "system",
                content: "Return the official website domain of the named company. Use bare domains only, like acme.com. If you are not sure, return an empty list. Output JSON {\"domains\": [\"...\"]} with at most 3 entries.",
            },
            {
                role: "user",
                content: `Company: ${context.effectiveCompany}\nIndustry hint: ${context.industryHint || "unknown"}`,
            },
        ],
    });
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    return (Array.isArray(parsed.domains) ? parsed.domains : []).map(String).slice(0, 3);
}

// Used when the lead's email is a personal mailbox: find the company's site from its name,
// and accept a candidate only after fetching it and seeing the brand on the page.
export async function discoverCompanyWebsite(context) {
    const company = context.effectiveCompany;
    if (!company || company === "Unknown organization" || process.env.ASE_RESEARCH_FETCH_SITE === "false") return null;
    const candidates = [];
    const add = (domain, method) => {
        const clean = cleanDomain(domain);
        if (clean && !candidates.some((c) => c.domain === clean)) candidates.push({ domain: clean, method });
    };
    const reference = await findOfficialWebsite(company).catch(() => null);
    if (reference?.domain) add(reference.domain, "discovered_wikidata_official_site");
    const suggested = await suggestDomainsWithOpenAi(context).catch(() => []);
    for (const domain of suggested) add(domain, "discovered_name_lookup_verified_site");
    const slug = companyCoreTokens(company).join("");
    if (slug.length >= 3) add(`${slug}.com`, "discovered_name_slug_verified_site");

    for (const candidate of candidates.slice(0, 4)) {
        const pages = await fetchCompanySite(candidate.domain, {
            acceptHome: (home) => siteMatchesCompany(company, home, candidate.domain),
        }).catch(() => []);
        if (pages.length) return { ...candidate, pages };
        // Wikidata's official-site claim is itself a source, so keep it even if the site blocks our fetcher.
        if (candidate.method === "discovered_wikidata_official_site") return { ...candidate, pages: [], siteUnreachable: true };
    }
    return null;
}

async function researchFromWebsite(context) {
    if (!context.effectiveDomain || context.siteUnreachable || process.env.ASE_RESEARCH_FETCH_SITE === "false") return null;
    const sitePages = context.sitePages?.length
        ? context.sitePages
        : await fetchCompanySite(context.effectiveDomain).catch(() => []);
    if (!sitePages.length) return null;
    const siteContext = { ...context, sitePages };
    const client = getResearchOpenAiClient();
    const [extracted, hiring] = await Promise.all([
        extractVerifiedFacts(client, { company: context.effectiveCompany, pages: sitePages }).catch((error) => {
            console.warn("[CompanyResearch] Website extraction failed:", error.message);
            return null;
        }),
        fetchHiringSignals(sitePages).catch(() => null),
    ]);
    return buildProfile(siteContext, {
        summary: extracted?.summary || null,
        industry: extracted?.industry || "",
        coreServices: extracted?.coreServices || "",
        targetAudience: extracted?.targetAudience || "",
        facts: extracted?.facts || [],
        rejectedFacts: extracted?.rejected || [],
        technologies: mergeTechnologies(sitePages),
        hiring,
        source: "website_scrape",
    });
}

async function researchFromReference(context) {
    if (!context.effectiveDomain || process.env.ASE_RESEARCH_REFERENCE === "false") return null;
    const page = await findReferencePage(context.effectiveCompany, context.effectiveDomain);
    if (!page) return null;
    const refContext = { ...context, sitePages: [page] };
    const summarized = await summarizeSiteWithOpenAi(refContext).catch(() => null);
    return buildProfile(refContext, {
        ...(summarized || {}),
        source: "wikipedia_reference",
        qualityStatus: "ACCEPTABLE",
        qualityReasons: ["DOMAIN_RESOLVED", "THIRD_PARTY_SOURCE", "WIKIDATA_OFFICIAL_SITE_MATCH"],
    });
}

export async function enrichWithWebSearch(profile, context, options = {}) {
    if (!isGroundedResearch(profile) || !context.effectiveDomain) return profile;
    let result;
    try {
        result = await searchCompanyEvents(options.client || getResearchOpenAiClient(), {
            company: profile.company || context.effectiveCompany,
            domain: context.effectiveDomain,
        }, options);
    } catch (error) {
        console.warn("[CompanyResearch] Web search failed:", error.message);
        return { ...profile, webSearch: { status: "error" } };
    }
    if (result.status !== "ok") return result.status === "disabled" ? profile : { ...profile, webSearch: { status: result.status } };
    const knownUrls = new Set(profile.sources.map((source) => source.url));
    const newSources = result.facts
        .filter((fact) => !knownUrls.has(fact.sourceUrl) && knownUrls.add(fact.sourceUrl))
        .map((fact) => ({
            url: fact.sourceUrl,
            pageType: "third_party",
            title: fact.sourceTitle,
            retrievedAt: fact.retrievedAt,
            excerpt: fact.evidenceExcerpt,
        }));
    return {
        ...profile,
        sources: [...profile.sources, ...newSources],
        facts: [...profile.facts, ...result.facts],
        ...(result.rejected.length ? { rejectedFacts: [...(profile.rejectedFacts || []), ...result.rejected] } : {}),
        qualityReasons: result.facts.length ? [...profile.qualityReasons, "WEB_SEARCH_VERIFIED"] : profile.qualityReasons,
        webSearch: { status: "ok", verified: result.facts.length, rejected: result.rejected.length, searchedAt: result.searchedAt },
    };
}

async function researchGrounded(context) {
    try {
        const fromSite = await researchFromWebsite(context);
        if (fromSite && fromSite.qualityStatus !== "INSUFFICIENT_EVIDENCE") return fromSite;
    } catch (error) {
        console.warn("[CompanyResearch] Website research failed:", error.message);
    }
    try {
        return await researchFromReference(context);
    } catch (error) {
        console.warn("[CompanyResearch] Reference research failed:", error.message);
        return null;
    }
}

async function researchUncached(context) {
    if (!context.effectiveDomain) {
        const found = await discoverCompanyWebsite(context).catch((error) => {
            console.warn("[CompanyResearch] Website discovery failed:", error.message);
            return null;
        });
        if (found) {
            context.effectiveDomain = found.domain;
            context.sitePages = found.pages;
            context.resolutionMethod = found.method;
            context.siteUnreachable = Boolean(found.siteUnreachable);
        }
    }
    const grounded = await researchGrounded(context);
    if (grounded) return enrichWithWebSearch(grounded, context);
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
    if (meta.company_research_status === "failed" && !meta.outreach_email?.subject) return false;
    if (lead?.company && !isUsableResearchProfile(meta.company_research)) return true;
    if (isUsableResearchProfile(meta.company_research) && !meta.outreach_email?.subject) return true;
    return false;
}

export async function researchCompany(companyName, options = {}) {
    const contextOptions = options.force
        ? { ...options, leadInfo: { ...(options.leadInfo || {}), metadata: {} } }
        : options;
    const context = await loadCompanyContext(companyName, contextOptions);
    if (context.cachedResearch && !options.force) return context.cachedResearch;

    const key = cacheKey(context.effectiveDomain, context.effectiveCompany, context.orgId);
    if (researchInflight.has(key)) return researchInflight.get(key);

    const initialDomain = context.effectiveDomain;
    const job = researchUncached(context)
        .then((research) => {
            rememberCompanyResearch(context.effectiveDomain, context.effectiveCompany, research, context.orgId);
            if (!initialDomain && context.effectiveDomain) {
                rememberCompanyResearch(null, context.effectiveCompany, research, context.orgId);
            }
            return research;
        })
        .finally(() => researchInflight.delete(key));

    researchInflight.set(key, job);
    return job;
}

export { heuristicResearch, cleanDomain, isBlockedAddress };

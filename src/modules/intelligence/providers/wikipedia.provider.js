const TIMEOUT_MS = Number(process.env.ASE_RESEARCH_FETCH_TIMEOUT_MS || 6000);
const USER_AGENT = "NovaResearchBot/1.0 (+public company website summary)";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIPEDIA_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const OFFICIAL_WEBSITE = "P856";

async function getJson(url) {
    const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return res.json();
}

function hostOf(url) {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return "";
    }
}

function brandLabel(host) {
    return String(host || "").split(".")[0];
}

// A reference entity is accepted only when its listed official website is the lead's domain,
// or shares the brand label and the entity name matches the company name.
export function matchesCompanyDomain({ officialSites, entityLabel, domain, companyName }) {
    const target = String(domain || "").toLowerCase().replace(/^www\./, "");
    if (!target) return false;
    const hosts = (officialSites || []).map(hostOf).filter(Boolean);
    if (hosts.some((host) => host === target || host.endsWith(`.${target}`) || target.endsWith(`.${host}`))) return true;
    const sameBrand = hosts.some((host) => brandLabel(host) === brandLabel(target));
    const norm = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return sameBrand && Boolean(norm(companyName)) && norm(entityLabel) === norm(companyName);
}

function officialSitesOf(entity) {
    return (entity?.claims?.[OFFICIAL_WEBSITE] || [])
        .map((claim) => claim?.mainsnak?.datavalue?.value)
        .filter((value) => typeof value === "string");
}

export async function findReferencePage(companyName, domain) {
    const name = String(companyName || "").trim();
    if (!name || !domain) return null;
    const search = await getJson(`${WIKIDATA_API}?action=wbsearchentities&format=json&language=en&type=item&limit=5&search=${encodeURIComponent(name)}`);
    const ids = (search?.search || []).map((item) => item.id).filter(Boolean);
    if (!ids.length) return null;
    const entities = await getJson(`${WIKIDATA_API}?action=wbgetentities&format=json&props=claims|sitelinks|labels&languages=en&sitefilter=enwiki&ids=${ids.join("|")}`);
    for (const id of ids) {
        const entity = entities?.entities?.[id];
        const title = entity?.sitelinks?.enwiki?.title;
        if (!title) continue;
        const officialSites = officialSitesOf(entity);
        if (!matchesCompanyDomain({ officialSites, entityLabel: entity?.labels?.en?.value, domain, companyName: name })) continue;
        const summary = await getJson(`${WIKIPEDIA_SUMMARY}${encodeURIComponent(title.replace(/ /g, "_"))}`);
        const extract = String(summary?.extract || "").replace(/\s+/g, " ").trim();
        if (!extract || summary?.type === "disambiguation") continue;
        return {
            url: summary?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
            title: summary?.title || title,
            description: extract.slice(0, 400),
            siteName: "Wikipedia",
            pageType: "reference",
            headings: [],
            excerpt: extract.slice(0, 1200),
            retrievedAt: new Date().toISOString(),
            wikidataId: id,
            officialSites,
        };
    }
    return null;
}

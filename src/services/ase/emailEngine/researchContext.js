import { isGroundedResearch } from "../companyResearch.service.js";
import { buildOutreachSignals } from "../../../modules/intelligence/services/signals.service.js";
import { INJECTION_PATTERN } from "../emailQuality.service.js";

export const RESEARCH_STRENGTH = Object.freeze({
    STRONG: "STRONG",
    PARTIAL: "PARTIAL",
    NONE: "NONE",
});

const USEFUL_FIELDS = new Set(["overview", "pageOverview", "product", "service", "services", "customer", "industry", "update", "audience", "mission", "about", "employees", "employee_count", "company_size", "headquarters", "location", "market", "founded"]);
const SINGLE_VALUED_FIELDS = new Set(["employees", "employee_count", "company_size", "headcount", "revenue", "founded", "headquarters", "location"]);
const DISPUTED_STATUSES = new Set(["conflicting", "disputed", "contradicted"]);
const MAX_FACTS = 8;

export function findConflictingFields(facts = []) {
    const values = new Map();
    for (const fact of facts) {
        const status = String(fact?.verificationStatus || "").toLowerCase();
        if (status !== "verified" || !SINGLE_VALUED_FIELDS.has(fact.field)) continue;
        const normalized = String(fact.value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!normalized) continue;
        if (!values.has(fact.field)) values.set(fact.field, new Set());
        values.get(fact.field).add(normalized);
    }
    return new Set([...values.entries()].filter(([, set]) => set.size > 1).map(([field]) => field));
}

function cleanValue(value, max = 280) {
    const text = String(value || "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!text || INJECTION_PATTERN.test(text)) return "";
    return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return null;
    }
}

export function buildResearchContext(research, { company = "" } = {}) {
    const grounded = isGroundedResearch(research);
    const sources = (research?.sources || [])
        .filter((source) => source?.url)
        .slice(0, 5)
        .map((source) => ({ url: source.url, title: cleanValue(source.title, 120) || hostOf(source.url) }));

    const inferred = [];
    if (research?.growthOpportunity) {
        const value = cleanValue(research.growthOpportunity);
        if (value) inferred.push({ label: "Possible opportunity", value, status: "inferred" });
    }
    if (research?.unverifiedHypothesis) {
        const value = cleanValue(research.unverifiedHypothesis);
        if (value) inferred.push({ label: "Unverified hypothesis (not used in email)", value, status: "inferred", promptSafe: false });
    }

    if (!grounded) {
        return {
            grounded: false,
            strength: RESEARCH_STRENGTH.NONE,
            company: research?.company || company || null,
            summary: null,
            industry: null,
            coreServices: null,
            targetAudience: null,
            facts: [],
            signals: [],
            inferred,
            disputed: [],
            sources,
            qualityStatus: research?.qualityStatus || null,
        };
    }

    const facts = [];
    const seen = new Set();
    const push = (field, value, sourceUrl) => {
        const clean = cleanValue(value);
        const key = clean.toLowerCase();
        if (!clean || seen.has(key) || facts.length >= MAX_FACTS) return;
        seen.add(key);
        facts.push({ id: `F${facts.length + 1}`, field, value: clean, sourceUrl: sourceUrl || sources[0]?.url || null, status: "verified" });
    };

    const conflicts = findConflictingFields(research.facts || []);
    const disputed = [];
    push("summary", research.summary, sources[0]?.url);
    for (const fact of research.facts || []) {
        const status = String(fact?.verificationStatus || "").toLowerCase();
        if (DISPUTED_STATUSES.has(status) || fact?.conflict || conflicts.has(fact?.field)) {
            if (fact?.value) disputed.push({ field: fact.field, value: cleanValue(fact.value, 160), status: "disputed" });
            continue;
        }
        if (status !== "verified") continue;
        if (!USEFUL_FIELDS.has(fact.field) && !String(fact.field || "").startsWith("web_")) continue;
        push(fact.field, fact.value, fact.sourceUrl);
    }

    const signals = buildOutreachSignals(research)
        .map((signal, index) => ({ id: `S${index + 1}`, type: signal.type, value: cleanValue(signal.text, 320), sourceUrl: signal.sourceUrl || null, status: "verified" }))
        .filter((signal) => signal.value);

    const strength = facts.length >= 3 || signals.length ? RESEARCH_STRENGTH.STRONG : RESEARCH_STRENGTH.PARTIAL;
    return {
        grounded: true,
        strength,
        company: research.company || company || null,
        summary: cleanValue(research.summary, 600),
        industry: cleanValue(research.industry, 120) || null,
        coreServices: cleanValue(research.coreServices, 300) || null,
        targetAudience: cleanValue(research.targetAudience, 200) || null,
        facts,
        signals,
        inferred,
        disputed,
        sources,
        qualityStatus: research.qualityStatus || null,
    };
}

export function evidenceById(researchContext) {
    const map = new Map();
    for (const item of [...(researchContext?.facts || []), ...(researchContext?.signals || [])]) map.set(item.id, item);
    return map;
}

export function evidenceText(researchContext) {
    if (!researchContext?.grounded) return "";
    return [
        researchContext.company,
        researchContext.summary,
        researchContext.industry,
        researchContext.coreServices,
        researchContext.targetAudience,
        ...researchContext.facts.map((fact) => fact.value),
        ...researchContext.signals.map((signal) => signal.value),
    ].filter(Boolean).join("\n");
}

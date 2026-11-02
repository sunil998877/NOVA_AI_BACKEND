import crypto from "crypto";
import { textSimilarity } from "../emailQuality.service.js";
import { openingOf } from "./communicationHistory.js";

export const SIMILARITY_THRESHOLDS = Object.freeze({
    LEAD_SIMILAR: 0.45,
    LEAD_NEAR_DUPLICATE: 0.8,
    ORG_OPENING: 0.8,
    ORG_BODY: 0.85,
});

function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeForComparison(text, { firstName = "", company = "" } = {}) {
    let out = String(text || "").replace(/\r\n/g, "\n");
    out = out.replace(/^\s*(hi|hello|dear)\b[^\n]*\n+/i, "");
    out = out.replace(/\n+\s*(best regards|kind regards|regards|thanks|best)[\s\S]*$/i, "");
    if (firstName && firstName !== "there") out = out.replace(new RegExp(`\\b${escapeRegex(firstName)}\\b`, "gi"), "{first_name}");
    if (company) out = out.replace(new RegExp(`\\b${escapeRegex(company)}\\b`, "gi"), "{company}");
    return out.toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizeSubject(subject, { company = "" } = {}) {
    let out = String(subject || "").replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "");
    if (company) out = out.replace(new RegExp(`\\b${escapeRegex(company)}\\b`, "gi"), "{company}");
    return out.toLowerCase().replace(/\s+/g, " ").trim();
}

export function bodyHash(normalized) {
    return crypto.createHash("sha1").update(String(normalized || "")).digest("hex").slice(0, 20);
}

export function buildFingerprint({ subject, text }, { firstName, company, angle = null, ctaStyle = null, capabilities = [] } = {}) {
    const normalized = normalizeForComparison(text, { firstName, company });
    return {
        subjectKey: normalizeSubject(subject, { company }),
        opening: normalizeForComparison(openingOf(text), { firstName, company }).slice(0, 240),
        hash: bodyHash(normalized),
        angle,
        ctaStyle,
        capabilities,
    };
}

export function checkSimilarity({ subject, text }, { firstName, company, history, orgRecent = [], capabilitiesUsed = [], stage = null } = {}) {
    const issues = [];
    const normalized = normalizeForComparison(text, { firstName, company });
    const fingerprint = buildFingerprint({ subject, text }, { firstName, company });

    const leadBodies = (history?.previousBodies || []).map((body) => normalizeForComparison(body, { firstName, company }));
    const leadSimilarity = leadBodies.reduce((max, body) => Math.max(max, textSimilarity(normalized, body)), 0);
    if (leadSimilarity >= SIMILARITY_THRESHOLDS.LEAD_NEAR_DUPLICATE) issues.push("NEAR_DUPLICATE_OF_PREVIOUS_EMAIL");
    else if (leadSimilarity >= SIMILARITY_THRESHOLDS.LEAD_SIMILAR) issues.push("SIMILAR_TO_PREVIOUS_EMAIL");

    const leadSubjects = (history?.previousSubjects || []).map((item) => normalizeSubject(item, { company }));
    if (stage === "FOLLOW_UP_NO_REPLY" || stage === "FIRST_OUTREACH") {
        if (leadSubjects.includes(fingerprint.subjectKey)) issues.push("REPEATED_SUBJECT");
        const leadOpenings = (history?.previousOpenings || []).map((item) => normalizeForComparison(item, { firstName, company }));
        if (leadOpenings.some((opening) => textSimilarity(opening, fingerprint.opening) >= SIMILARITY_THRESHOLDS.ORG_OPENING)) issues.push("REPEATED_OPENING");
    }

    const previousCaps = new Set(history?.previousCapabilities || []);
    if (stage === "FOLLOW_UP_NO_REPLY" && capabilitiesUsed.length && capabilitiesUsed.every((key) => previousCaps.has(key))) {
        issues.push("REPEATED_VALUE_PROPOSITION");
    }

    let orgSimilarity = 0;
    let identical = 0;
    let sameOpening = 0;
    let sameSubject = 0;
    for (const item of orgRecent) {
        if (item.hash && item.hash === fingerprint.hash) identical += 1;
        if (item.opening && textSimilarity(item.opening, fingerprint.opening) >= SIMILARITY_THRESHOLDS.ORG_OPENING) sameOpening += 1;
        if (item.subjectKey && item.subjectKey === fingerprint.subjectKey) sameSubject += 1;
        if (item.bodyNormalized) orgSimilarity = Math.max(orgSimilarity, textSimilarity(item.bodyNormalized, normalized));
    }
    if (identical) issues.push("IDENTICAL_BODY_ACROSS_LEADS");
    if (sameOpening >= 2) issues.push("REPEATED_OPENING_ACROSS_LEADS");
    if (sameSubject >= 3) issues.push("REPEATED_SUBJECT_ACROSS_LEADS");
    if (orgSimilarity >= SIMILARITY_THRESHOLDS.ORG_BODY && !identical) issues.push("NEAR_DUPLICATE_ACROSS_LEADS");

    return {
        leadSimilarity: Number(leadSimilarity.toFixed(3)),
        orgSimilarity: Number(orgSimilarity.toFixed(3)),
        similarityScore: Number(Math.max(leadSimilarity, orgSimilarity).toFixed(3)),
        issues: [...new Set(issues)],
        fingerprint,
        blocking: issues.some((issue) => ["NEAR_DUPLICATE_OF_PREVIOUS_EMAIL", "IDENTICAL_BODY_ACROSS_LEADS"].includes(issue)),
    };
}

const STAT_PATTERN = /\b\d+(\.\d+)?\s?(%|percent|x)\b|\$\s?\d|\bROI\b|\bguarantee[ds]?\b|\b\d+\s?(customers|clients|users|million|billion)\b/i;
const INJECTION_PATTERN = /ignore (all |any |previous |prior )?instructions|system prompt|reveal (the )?(secret|api key)|you are now/i;

export function validateEmailDraft({ subject = "", text = "", html = "", research = null } = {}) {
    const body = `${subject}\n${text}\n${String(html || "").replace(/<[^>]+>/g, " ")}`;
    const issues = [];
    if (!String(subject).trim() || !String(text).trim()) issues.push("MISSING_FIELDS");
    if (String(subject).trim().length > 120) issues.push("SUBJECT_TOO_LONG");
    const words = String(text).trim().split(/\s+/).filter(Boolean);
    if (words.length > 220) issues.push("BODY_TOO_LONG");
    if (STAT_PATTERN.test(body)) issues.push("UNVERIFIED_STATISTIC");
    if (INJECTION_PATTERN.test(body)) issues.push("PROMPT_INJECTION");
    const quality = research?.qualityStatus || null;
    const grounded = Boolean(research?.summary) && quality !== "INSUFFICIENT_EVIDENCE";
    const factualGrounding = issues.includes("UNVERIFIED_STATISTIC") || issues.includes("PROMPT_INJECTION")
        ? "failed"
        : (grounded ? "passed" : "conservative");
    return {
        factualGrounding,
        duplicateCheck: "pending",
        complianceCheck: issues.includes("PROMPT_INJECTION") ? "failed" : "passed",
        issues,
        eligibleToSend: issues.length === 0,
        qualityStatus: quality,
    };
}

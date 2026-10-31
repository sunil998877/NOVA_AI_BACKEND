const STAT_PATTERN = /\b\d+(\.\d+)?\s?(%|percent|x)\b|\$\s?\d|\bROI\b|\bguarantee[ds]?\b|\b\d+\s?(customers|clients|users|million|billion)\b/i;
const INJECTION_PATTERN = /ignore (all |any |previous |prior )?instructions|system prompt|reveal (the )?(secret|api key)|you are now/i;
const CONVERSATION_CLAIM_PATTERN = /\b(as (we|i) (discussed|spoke|talked|mentioned)|as discussed|(great|nice|good|lovely) (speaking|talking|chatting|connecting) (with|to) you|(great|nice|good) to (speak|talk|chat|connect) (with|to) you|thanks? (you )?for (taking|your time on|the) (my |our |the )?(call|time on the phone|conversation|chat)|per our (call|conversation|discussion|chat)|following up on our (call|conversation|discussion|chat)|when we (spoke|talked|chatted)|you (mentioned|told me|said) (on|during) (the|our) (call|conversation)|as promised (on|during) (the|our) call|during our (call|conversation|chat)|our (recent|earlier) (call|conversation|chat))\b/i;
const NEAR_DUPLICATE_THRESHOLD = 0.8;

export function findConversationClaims(text = "") {
    const matches = [];
    const re = new RegExp(CONVERSATION_CLAIM_PATTERN.source, "gi");
    let match;
    while ((match = re.exec(String(text || "")))) matches.push(match[0]);
    return matches;
}

function shingles(text, size = 3) {
    const words = String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    const set = new Set();
    for (let i = 0; i + size <= words.length; i += 1) set.add(words.slice(i, i + size).join(" "));
    return set;
}

export function textSimilarity(a, b) {
    const left = shingles(a);
    const right = shingles(b);
    if (!left.size || !right.size) return 0;
    let overlap = 0;
    for (const item of left) if (right.has(item)) overlap += 1;
    return overlap / (left.size + right.size - overlap);
}

export function validateEmailDraft({ subject = "", text = "", html = "", research = null, noPriorConversation = false, previousBodies = [] } = {}) {
    const body = `${subject}\n${text}\n${String(html || "").replace(/<[^>]+>/g, " ")}`;
    const issues = [];
    if (!String(subject).trim() || !String(text).trim()) issues.push("MISSING_FIELDS");
    if (String(subject).trim().length > 120) issues.push("SUBJECT_TOO_LONG");
    const words = String(text).trim().split(/\s+/).filter(Boolean);
    if (words.length > 220) issues.push("BODY_TOO_LONG");
    if (STAT_PATTERN.test(body)) issues.push("UNVERIFIED_STATISTIC");
    if (INJECTION_PATTERN.test(body)) issues.push("PROMPT_INJECTION");
    if (noPriorConversation && CONVERSATION_CLAIM_PATTERN.test(body)) issues.push("IMPLIES_PRIOR_CONVERSATION");
    const maxSimilarity = (previousBodies || []).reduce((max, prev) => Math.max(max, textSimilarity(text, prev)), 0);
    if (maxSimilarity >= NEAR_DUPLICATE_THRESHOLD) issues.push("NEAR_DUPLICATE");
    const quality = research?.qualityStatus || null;
    const grounded = Boolean(research?.summary) && quality !== "INSUFFICIENT_EVIDENCE";
    const factualGrounding = issues.includes("UNVERIFIED_STATISTIC") || issues.includes("PROMPT_INJECTION") || issues.includes("IMPLIES_PRIOR_CONVERSATION")
        ? "failed"
        : (grounded ? "passed" : "conservative");
    return {
        factualGrounding,
        duplicateCheck: previousBodies?.length ? (issues.includes("NEAR_DUPLICATE") ? "failed" : "passed") : "pending",
        complianceCheck: issues.includes("PROMPT_INJECTION") ? "failed" : "passed",
        issues,
        eligibleToSend: issues.length === 0,
        qualityStatus: quality,
        maxSimilarity: Number(maxSimilarity.toFixed(3)),
    };
}

import { validateEmailDraft } from "../emailQuality.service.js";
import { guardReplyDraft } from "../replyDrafter.service.js";
import { CONVERSATION_STAGES, REPLY_STAGES } from "./communicationHistory.js";
import { evidenceById, evidenceText } from "./researchContext.js";
import { mentionedCapabilities, sellerFactsForGuard } from "./productKnowledge.js";
import { CLICHES } from "./emailPrompt.js";

export const QUALITY_WEIGHTS = Object.freeze({
    companyPersonalization: 20,
    industryRelevance: 15,
    contactRoleRelevance: 15,
    verifiedCompanyFacts: 15,
    novaValueProposition: 15,
    naturalLanguage: 10,
    ctaClarity: 10,
});

export const CONVERSATION_BLOCKERS = new Set([
    "FALSE_FOLLOW_UP_REFERENCE",
    "REINTRODUCES_BRAND_IN_FOLLOW_UP",
    "REINTRODUCES_BRAND_IN_CONVERSATION",
    "QUESTION_NOT_ADDRESSED",
    "OBJECTION_NOT_ACKNOWLEDGED",
    "CALLBACK_NOT_ACKNOWLEDGED",
]);

export const QUALITY_BANDS = Object.freeze({ HIGH: "HIGH", ACCEPTABLE: "ACCEPTABLE", LOW: "LOW" });
export const MIN_ACCEPTABLE_SCORE = 70;

const HARD_GATE_ISSUES = new Set([
    "MISSING_FIELDS",
    "SUBJECT_TOO_LONG",
    "BODY_TOO_LONG",
    "UNVERIFIED_STATISTIC",
    "PROMPT_INJECTION",
    "IMPLIES_PRIOR_CONVERSATION",
    "PLACEHOLDER_TEXT",
    "UNSUPPORTED_NUMBER",
    "PRICING_NOT_IN_PLAYBOOK",
    "UNSUPPORTED_PROMISE",
    "CLAIMS_MEETING_BOOKED",
    "CAPABILITY_NOT_IN_PLAYBOOK",
    "NEVER_CLAIM_VIOLATION",
    "UNGROUNDED_COMPANY_CLAIM",
    "UNSUPPORTED_COMPANY_CLAIM",
    "ASSUMED_JOB_TITLE",
    "ASSERTED_PROSPECT_PROBLEM",
]);

const ASSERTED_PROBLEM = /\b(i know|i'm sure|i am sure|clearly|obviously|it's clear)\b[^.?!]{0,40}\b(you|your)\b[^.?!]{0,40}\b(struggl\w*|problems?|challenges?|pain|issues?|difficult\w*)\b|\byour (team|company|business) (struggles|is struggling|has trouble|is losing|is wasting)\b/i;

const HYPE_WORDS = /\b(innovative|powerful|robust|comprehensive|revolutionary|world-class|best-in-class|incredible|amazing|cutting-edge|state-of-the-art|next-generation|unparalleled|seamless(ly)?)\b/gi;
const FOLLOW_UP_LANGUAGE = /\b(following up|follow up on my|my (earlier|previous|last) (note|email|message)|circling back|bumping this)\b/i;
const REINTRO_LANGUAGE = /\b(i am reaching out from|i'm reaching out from|my name is|allow me to introduce|i'd like to introduce|let me introduce)\b/i;
const ACKNOWLEDGE_LANGUAGE = /\b(thank|thanks|understand|makes sense|fair point|appreciate)\b/i;
const ROLE_ASSUMPTION = /\b(as (a|an|the) (ceo|founder|head|manager|director|vp|leader|owner|executive)|your role as|in your position as)\b/i;
const CLAIM_VERBS = "(is|are|was|has|have|offers?|provides?|speciali[sz](es|ing)|helps?|serves?|builds?|develops?|recently|announced|launched|raised|expanded|acquired|works with|focuses on|sells|operates|runs)";
const STOPWORDS = new Set(["that", "this", "with", "your", "their", "they", "them", "from", "into", "over", "more", "most", "very", "also", "such", "like", "just", "have", "will", "well", "what", "when", "which", "been", "were", "about", "noticed", "website", "site", "page", "work", "describes", "looking", "where", "there", "here", "company", "team", "teams", "business"]);

function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sentencesOf(text) {
    return String(text || "").replace(/\n+/g, " ").split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

function stems(text, exclude = new Set()) {
    return (String(text || "").toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || [])
        .filter((word) => !STOPWORDS.has(word) && !exclude.has(word))
        .map((word) => word.slice(0, 5));
}

function overlapRatio(sentence, evidence, exclude) {
    const words = stems(sentence, exclude);
    if (words.length < 2) return 1;
    const pool = new Set(stems(evidence));
    return words.filter((word) => pool.has(word)).length / words.length;
}

function wordCount(text) {
    return String(text || "").split(/\s+/).filter(Boolean).length;
}

export function findCompanyClaims(body, company) {
    const subjects = [company ? escapeRegex(company) : null, "your (company|business|organi[sz]ation)"].filter(Boolean).join("|");
    const claim = new RegExp(`\\b(${subjects})('s)?\\s+(\\w+\\s+){0,2}${CLAIM_VERBS}\\b|\\bi (saw|noticed|read|see|was looking at|learned)\\b`, "i");
    return sentencesOf(body).filter((sentence) => !/\?$/.test(sentence) && claim.test(sentence));
}

export function checkHardGates({ subject, text, body }, context) {
    const { company, role, research, history, knowledge } = context;
    const failures = [];
    const base = validateEmailDraft({
        subject,
        text,
        research: { summary: research.summary, qualityStatus: research.qualityStatus },
        noPriorConversation: !history.hasSpokenWithProspect,
    });
    failures.push(...base.issues.filter((issue) => HARD_GATE_ISSUES.has(issue)));

    const guardText = String(text || "")
        .replace(/\b\d{1,2}[\s-]?min(ute)?s?\b/gi, "brief")
        .replace(/\b[a-z]+\d+[a-z]+\b/gi, "term");
    const guard = guardReplyDraft({ subject, text: guardText }, {
        seller: sellerFactsForGuard(knowledge),
        research: {
            grounded: research.grounded,
            company: research.company,
            summary: research.summary || "",
            facts: [...research.facts, ...research.signals].map((item) => ({ value: item.value })),
        },
        history: history.items,
        inbound: history.latestInbound ? { subject: history.latestInbound.subject, body_text: history.latestInbound.text } : null,
    });
    failures.push(...guard.filter((issue) => HARD_GATE_ISSUES.has(issue) && issue !== "BODY_TOO_LONG"));

    const claims = findCompanyClaims(body, company);
    if (claims.length && !research.grounded) failures.push("UNGROUNDED_COMPANY_CLAIM");
    if (claims.length && research.grounded) {
        const evidence = evidenceText(research);
        const exclude = new Set(stems(company).map((word) => word));
        if (claims.some((sentence) => overlapRatio(sentence, evidence, exclude) < 0.4)) failures.push("UNSUPPORTED_COMPANY_CLAIM");
    }
    if (!role.titleKnown && ROLE_ASSUMPTION.test(body)) failures.push("ASSUMED_JOB_TITLE");
    if (ASSERTED_PROBLEM.test(body)) failures.push("ASSERTED_PROSPECT_PROBLEM");
    return { passed: failures.length === 0, failures: [...new Set(failures)], claims };
}

function scoreCompanyPersonalization({ subject, body }, context, warnings) {
    const { company, research, history, strategy } = context;
    let score = 0;
    const mentionsCompany = company && new RegExp(`\\b${escapeRegex(company)}\\b`, "i").test(`${subject}\n${body}`);
    if (mentionsCompany) score += 6;
    if (REPLY_STAGES.has(strategy.stage)) {
        const ratio = history.latestInbound?.text ? overlapRatio(history.latestInbound.text, body, new Set()) : 0;
        score += ratio >= 0.15 || strategy.stage === CONVERSATION_STAGES.CALLBACK_ACKNOWLEDGE ? 14 : 8;
        return Math.min(20, score);
    }
    if (!research.grounded) {
        warnings.push("INSUFFICIENT_RESEARCH");
        return score;
    }
    const evidence = evidenceText(research);
    const ratio = overlapRatio(body, evidence, new Set(stems(company)));
    if (ratio >= 0.12) score += 14;
    else if (ratio >= 0.06) score += 8;
    else warnings.push("WEAK_COMPANY_PERSONALIZATION");
    return Math.min(20, score);
}

function scoreRoleRelevance(body, context, warnings) {
    const { role } = context;
    const lower = body.toLowerCase();
    const hits = role.keywords.filter((keyword) => lower.includes(keyword)).length;
    if (!role.titleKnown) {
        warnings.push("MISSING_JOB_TITLE");
        return hits ? 9 : 6;
    }
    if (hits >= 2) return 15;
    if (hits === 1) return 10;
    warnings.push("WEAK_ROLE_RELEVANCE");
    return 4;
}

export function usedFactRefs(draft, body, research) {
    const evidence = evidenceById(research);
    return (draft.factRefs || []).map(String)
        .filter((ref) => evidence.has(ref) && overlapRatio(evidence.get(ref).value, body, new Set()) >= 0.15);
}

function scoreVerifiedFacts(draft, body, context, warnings) {
    const { research, strategy } = context;
    if (REPLY_STAGES.has(strategy.stage)) return research.grounded ? 12 : 9;
    if (!research.grounded) return 4;
    const evidence = evidenceById(research);
    const refs = (draft.factRefs || []).map(String);
    const valid = refs.filter((ref) => evidence.has(ref));
    if (refs.length > valid.length) warnings.push("INVALID_FACT_REFERENCE");
    if (usedFactRefs(draft, body, research).length) return 15;
    if (valid.length) return 9;
    const ratio = overlapRatio(body, evidenceText(research), new Set());
    if (ratio >= 0.12) return 11;
    warnings.push("RESEARCH_NOT_USED");
    return 4;
}

function scoreIndustryRelevance(body, context, warnings) {
    const { industry, research, strategy } = context;
    if (REPLY_STAGES.has(strategy.stage)) return 12;
    const lower = body.toLowerCase();
    const terms = [
        ...(industry?.keywords || []),
        ...stems(research.coreServices || "").map((stem) => stem),
    ].filter((term) => term && term.length >= 4);
    const hits = new Set(terms.filter((term) => lower.includes(term))).size;
    const opportunityHits = stems(industry?.opportunity || "").filter((stem) => stems(body).includes(stem)).length;
    if (!industry?.known && !industry?.subIndustry) {
        warnings.push("INDUSTRY_NOT_IDENTIFIED");
        return hits ? 9 : 7;
    }
    if (hits >= 1 && opportunityHits >= 1) return 15;
    if (hits >= 1 || opportunityHits >= 2) return 11;
    if (opportunityHits === 1) return 8;
    warnings.push("WEAK_INDUSTRY_RELEVANCE");
    return 4;
}

function scoreValueProposition(body, context, warnings) {
    const { knowledge, strategy } = context;
    if (strategy.stage === CONVERSATION_STAGES.CALLBACK_ACKNOWLEDGE) return 15;
    const mentioned = mentionedCapabilities(body, knowledge).length;
    let score;
    if (mentioned >= 1 && mentioned <= 3) score = 15;
    else if (mentioned === 4) score = 10;
    else if (mentioned >= 5) {
        warnings.push("FEATURE_DUMP");
        score = 6;
    } else {
        score = [CONVERSATION_STAGES.ANSWER_QUESTION, CONVERSATION_STAGES.HANDLE_OBJECTION].includes(strategy.stage) ? 11 : 3;
        if (score === 3) warnings.push("NO_CLEAR_VALUE_PROPOSITION");
    }
    if (strategy.stage === CONVERSATION_STAGES.FIRST_OUTREACH && !body.toLowerCase().includes(String(knowledge.brandName).toLowerCase())) {
        score = Math.max(0, score - 4);
        warnings.push("BRAND_NOT_NAMED");
    }
    return score;
}

export function checkConversationAwareness(body, context) {
    const { strategy, history } = context;
    const issues = [];
    switch (strategy.stage) {
        case CONVERSATION_STAGES.FIRST_OUTREACH:
            if (FOLLOW_UP_LANGUAGE.test(body)) issues.push("FALSE_FOLLOW_UP_REFERENCE");
            break;
        case CONVERSATION_STAGES.FOLLOW_UP_NO_REPLY:
            if (REINTRO_LANGUAGE.test(body)) issues.push("REINTRODUCES_BRAND_IN_FOLLOW_UP");
            break;
        case CONVERSATION_STAGES.ANSWER_QUESTION:
            if (overlapRatio(history.latestInbound?.text || "", body, new Set()) < 0.1 && !/\b(question|confirm)\b/i.test(body)) issues.push("QUESTION_NOT_ADDRESSED");
            break;
        case CONVERSATION_STAGES.HANDLE_OBJECTION:
            if (!ACKNOWLEDGE_LANGUAGE.test(body)) issues.push("OBJECTION_NOT_ACKNOWLEDGED");
            break;
        case CONVERSATION_STAGES.CALLBACK_ACKNOWLEDGE:
            if (!/\bcall\b/i.test(body)) issues.push("CALLBACK_NOT_ACKNOWLEDGED");
            break;
        default:
            if (REINTRO_LANGUAGE.test(body)) issues.push("REINTRODUCES_BRAND_IN_CONVERSATION");
    }
    return issues;
}

function scoreNaturalLanguage(body, context, warnings) {
    let score = 10;
    const lower = body.toLowerCase();
    const cliches = CLICHES.filter((phrase) => lower.includes(phrase.toLowerCase()));
    if (cliches.length) {
        score -= Math.min(6, cliches.length * 2);
        warnings.push("GENERIC_AI_PHRASING");
    }
    const hype = body.match(HYPE_WORDS) || [];
    if (hype.length >= 2) {
        score -= 2;
        warnings.push("EXCESSIVE_ADJECTIVES");
    }
    const sentences = sentencesOf(body).map((sentence) => sentence.toLowerCase());
    if (new Set(sentences).size < sentences.length) {
        score -= 3;
        warnings.push("REPEATED_SENTENCE");
    }
    if ((body.match(/!/g) || []).length > 1) score -= 2;
    const words = wordCount(body);
    const { min, max } = context.strategy.length;
    if (words > max * 1.3) {
        score -= 2;
        warnings.push("LONGER_THAN_GUIDELINE");
    } else if (words < min * 0.6) {
        score -= 1;
        warnings.push("SHORTER_THAN_GUIDELINE");
    }
    return Math.max(0, score);
}

function scoreCta(draft, body, warnings) {
    const questions = (body.match(/\?/g) || []).length;
    const ctaIsQuestion = /\?\s*\)?\s*$/.test(String(draft.cta || "").trim());
    if (questions === 1 && ctaIsQuestion) return 10;
    if (questions === 0) {
        warnings.push("NO_CLEAR_CTA");
        return 3;
    }
    warnings.push("MULTIPLE_QUESTIONS");
    return questions === 2 ? 6 : 2;
}

export function bandFor(score) {
    if (score >= 85) return QUALITY_BANDS.HIGH;
    if (score >= MIN_ACCEPTABLE_SCORE) return QUALITY_BANDS.ACCEPTABLE;
    return QUALITY_BANDS.LOW;
}

export function scoreEmail(draft, context) {
    const body = [...(draft.paragraphs || []), draft.cta].filter(Boolean).join("\n\n");
    const text = draft.text || [draft.greeting, body].filter(Boolean).join("\n\n");
    const warnings = [];
    const breakdown = {
        companyPersonalization: scoreCompanyPersonalization({ subject: draft.subject, body }, context, warnings),
        industryRelevance: scoreIndustryRelevance(body, context, warnings),
        contactRoleRelevance: scoreRoleRelevance(body, context, warnings),
        verifiedCompanyFacts: scoreVerifiedFacts(draft, body, context, warnings),
        novaValueProposition: scoreValueProposition(body, context, warnings),
        naturalLanguage: scoreNaturalLanguage(body, context, warnings),
        ctaClarity: scoreCta(draft, body, warnings),
    };
    const conversationIssues = checkConversationAwareness(body, context);
    warnings.push(...conversationIssues);
    const firstName = context.firstName;
    if (firstName && firstName !== "there" && !String(draft.greeting || "").includes(firstName)) warnings.push("GREETING_NAME_MISMATCH");
    const hardGate = checkHardGates({ subject: draft.subject, text, body }, context);
    const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
    return {
        score,
        band: bandFor(score),
        breakdown: Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, { score: value, max: QUALITY_WEIGHTS[key] }])),
        warnings: [...new Set(warnings)],
        conversationIssues,
        hardGate,
        wordCount: wordCount(body),
    };
}

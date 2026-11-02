import crypto from "crypto";
import { CONVERSATION_STAGES } from "./communicationHistory.js";
import { RESEARCH_STRENGTH } from "./researchContext.js";
import { selectCapabilities } from "./productKnowledge.js";

export const OPENING_STYLES = Object.freeze({
    COMPANY_FACT: "COMPANY_FACT",
    COMPANY_CONTEXT: "COMPANY_CONTEXT",
    ROLE_CHALLENGE: "ROLE_CHALLENGE",
    FOLLOW_UP_NEW_ANGLE: "FOLLOW_UP_NEW_ANGLE",
    REPLY_TO_PROSPECT: "REPLY_TO_PROSPECT",
});

export const CTA_STYLES = Object.freeze({
    BRIEF_DEMO: "BRIEF_DEMO",
    SHORT_CALL: "SHORT_CALL",
    WORTH_EXPLORING: "WORTH_EXPLORING",
    SEND_OVERVIEW: "SEND_OVERVIEW",
    SCHEDULE_NEXT_STEP: "SCHEDULE_NEXT_STEP",
    CONFIRM_CALL_TIME: "CONFIRM_CALL_TIME",
    LOW_PRESSURE: "LOW_PRESSURE",
    ANSWER_FOLLOW_UP: "ANSWER_FOLLOW_UP",
});

const LENGTH = {
    [CONVERSATION_STAGES.FIRST_OUTREACH]: { min: 80, max: 120 },
    [CONVERSATION_STAGES.FOLLOW_UP_NO_REPLY]: { min: 40, max: 90 },
    [CONVERSATION_STAGES.ANSWER_QUESTION]: { min: 40, max: 150 },
    [CONVERSATION_STAGES.CONTINUE_INTEREST]: { min: 40, max: 110 },
    [CONVERSATION_STAGES.HANDLE_OBJECTION]: { min: 40, max: 100 },
    [CONVERSATION_STAGES.CALLBACK_ACKNOWLEDGE]: { min: 25, max: 70 },
    [CONVERSATION_STAGES.ACTIVE_CONVERSATION]: { min: 40, max: 110 },
};

const STAGE_BRIEF = {
    [CONVERSATION_STAGES.FIRST_OUTREACH]: "First outreach. Introduce the sender's brand briefly and explain why it may be relevant to this prospect.",
    [CONVERSATION_STAGES.FOLLOW_UP_NO_REPLY]: "Follow-up: an earlier email got no reply. Keep it short, take a new angle, do not re-introduce the brand from scratch and do not repeat the earlier email.",
    [CONVERSATION_STAGES.ANSWER_QUESTION]: "The prospect asked a question. Answer it directly using only PRODUCT KNOWLEDGE. If the facts do not cover it, say you will confirm with the team. Do not force a sales pitch.",
    [CONVERSATION_STAGES.CONTINUE_INTEREST]: "The prospect expressed interest. Thank them briefly and propose one concrete next step.",
    [CONVERSATION_STAGES.HANDLE_OBJECTION]: "The prospect raised an objection or declined. Acknowledge it respectfully, address that specific point once if PRODUCT KNOWLEDGE allows, and do not push.",
    [CONVERSATION_STAGES.CALLBACK_ACKNOWLEDGE]: "The prospect asked for a call. Acknowledge it, say someone from the team will call, and ask for the best number and time. Do not promise a specific time and do not pitch.",
    [CONVERSATION_STAGES.ACTIVE_CONVERSATION]: "There is an ongoing email conversation. Continue it naturally; never introduce the brand as if this were the first contact.",
};

const CTA_BY_STAGE = {
    [CONVERSATION_STAGES.ANSWER_QUESTION]: [CTA_STYLES.ANSWER_FOLLOW_UP],
    [CONVERSATION_STAGES.CONTINUE_INTEREST]: [CTA_STYLES.SCHEDULE_NEXT_STEP],
    [CONVERSATION_STAGES.HANDLE_OBJECTION]: [CTA_STYLES.LOW_PRESSURE],
    [CONVERSATION_STAGES.CALLBACK_ACKNOWLEDGE]: [CTA_STYLES.CONFIRM_CALL_TIME],
    [CONVERSATION_STAGES.ACTIVE_CONVERSATION]: [CTA_STYLES.SCHEDULE_NEXT_STEP, CTA_STYLES.ANSWER_FOLLOW_UP],
    [CONVERSATION_STAGES.FOLLOW_UP_NO_REPLY]: [CTA_STYLES.WORTH_EXPLORING, CTA_STYLES.SEND_OVERVIEW, CTA_STYLES.SHORT_CALL],
    [CONVERSATION_STAGES.FIRST_OUTREACH]: [CTA_STYLES.BRIEF_DEMO, CTA_STYLES.SHORT_CALL, CTA_STYLES.WORTH_EXPLORING, CTA_STYLES.SEND_OVERVIEW],
};

export const CTA_GUIDANCE = {
    [CTA_STYLES.BRIEF_DEMO]: "Ask whether they would be open to a brief demo (for example 15 minutes).",
    [CTA_STYLES.SHORT_CALL]: "Ask whether a short call in the next week or two would be useful.",
    [CTA_STYLES.WORTH_EXPLORING]: "Ask whether this is worth exploring for their team right now.",
    [CTA_STYLES.SEND_OVERVIEW]: "Offer to send a short overview and ask if that would help.",
    [CTA_STYLES.SCHEDULE_NEXT_STEP]: "Propose one next step (a short demo or call) and ask what time suits them.",
    [CTA_STYLES.CONFIRM_CALL_TIME]: "Ask for the best number and time to reach them.",
    [CTA_STYLES.LOW_PRESSURE]: "Ask one low-pressure question, such as whether it is all right to check back later, or offer to close the loop.",
    [CTA_STYLES.ANSWER_FOLLOW_UP]: "Ask whether that answers their question or if they would like to see it in a short demo.",
};

export function variantSeed(...parts) {
    const hash = crypto.createHash("sha1").update(parts.map((part) => String(part ?? "")).join("|")).digest();
    return hash.readUInt32BE(0);
}

function pick(list, seed, avoid = []) {
    if (!list.length) return null;
    const preferred = list.filter((item) => !avoid.includes(item));
    const pool = preferred.length ? preferred : list;
    return pool[seed % pool.length];
}

function pickResearchHook(research, usedHooks = []) {
    if (!research?.grounded) return null;
    const used = new Set(usedHooks);
    const candidates = [
        ...research.signals.filter((signal) => ["products", "customers", "hiring", "update"].includes(signal.type) || String(signal.type).startsWith("news_")),
        ...research.facts.filter((fact) => fact.field !== "summary"),
        ...research.facts.filter((fact) => fact.field === "summary"),
    ];
    return candidates.find((item) => !used.has(item.value)) || candidates[0] || null;
}

function mostCommon(values = []) {
    const counts = new Map();
    for (const value of values) if (value) counts.set(value, (counts.get(value) || 0) + 1);
    let best = null;
    let bestCount = 0;
    for (const [value, count] of counts) {
        if (count > bestCount) {
            best = value;
            bestCount = count;
        }
    }
    return bestCount >= 3 ? best : null;
}

function questionTopicCapabilities(question, knowledge) {
    const lower = String(question || "").toLowerCase();
    if (!lower) return [];
    return knowledge.capabilities
        .filter((capability) => [capability.name.toLowerCase(), ...(capability.keywords || [])].some((term) => term && lower.includes(term)))
        .map((capability) => capability.key);
}

export function buildPersonalizationStrategy({ lead = {}, role, industry = null, research, history, knowledge, orgRecent = [], attempt = 0 }) {
    const stage = history.stage;
    const seed = variantSeed(lead.id || lead.email, stage, history.outboundCount, attempt);
    const isFirst = stage === CONVERSATION_STAGES.FIRST_OUTREACH;
    const isFollowUp = stage === CONVERSATION_STAGES.FOLLOW_UP_NO_REPLY;

    const angle = isFirst || isFollowUp
        ? pick(role.focusAreas, seed, history.previousAngles)
        : stage.toLowerCase();

    const questionText = stage === CONVERSATION_STAGES.ANSWER_QUESTION ? history.latestInbound?.text : "";
    const capabilityCount = stage === CONVERSATION_STAGES.CALLBACK_ACKNOWLEDGE ? 1 : (isFollowUp ? 1 + (seed % 2) : 2 + (seed % 2));
    const capabilities = selectCapabilities(knowledge, role, {
        exclude: isFollowUp ? history.previousCapabilities : [],
        prefer: questionTopicCapabilities(questionText, knowledge),
        industry,
        count: capabilityCount,
    });

    let openingStyle;
    if (!isFirst && !isFollowUp) openingStyle = OPENING_STYLES.REPLY_TO_PROSPECT;
    else if (isFollowUp) openingStyle = OPENING_STYLES.FOLLOW_UP_NEW_ANGLE;
    else if (research.strength === RESEARCH_STRENGTH.STRONG) openingStyle = OPENING_STYLES.COMPANY_FACT;
    else if (research.strength === RESEARCH_STRENGTH.PARTIAL) openingStyle = OPENING_STYLES.COMPANY_CONTEXT;
    else openingStyle = OPENING_STYLES.ROLE_CHALLENGE;

    const orgCommonCta = mostCommon(orgRecent.map((item) => item.ctaStyle));
    const ctaStyle = pick(CTA_BY_STAGE[stage] || CTA_BY_STAGE[CONVERSATION_STAGES.FIRST_OUTREACH], seed >>> 3, orgCommonCta ? [orgCommonCta] : []);
    const researchHook = isFirst || isFollowUp ? pickResearchHook(research, history.previousHooks || []) : null;

    const reasonParts = [];
    reasonParts.push(role.titleKnown
        ? `${role.title} (${role.label}): focus on ${angle}.`
        : "Job title not on record: neutral business framing, no assumed responsibilities.");
    if (industry?.known) reasonParts.push(`Industry: ${industry.label}${industry.verified ? "" : " (from lead record, unverified)"}; possible relevance: ${industry.opportunity}.`);
    else if (industry?.subIndustry) reasonParts.push(`Industry "${industry.subIndustry}" is outside the known list; framing derived from research wording.`);
    if (researchHook) reasonParts.push(`Opening grounded in verified research (${researchHook.id}).`);
    else if (research.strength === RESEARCH_STRENGTH.NONE) reasonParts.push("Company research insufficient: conservative personalization, no company claims.");
    reasonParts.push(`Stage ${stage.replace(/_/g, " ").toLowerCase()}.`);
    reasonParts.push(`Capabilities: ${capabilities.map((capability) => capability.name).join(", ")}.`);

    return {
        stage,
        stageBrief: STAGE_BRIEF[stage] || STAGE_BRIEF[CONVERSATION_STAGES.FIRST_OUTREACH],
        angle,
        openingStyle,
        ctaStyle,
        ctaGuidance: knowledge.preferredCta && isFirst
            ? `Adapt this call to action lightly: "${knowledge.preferredCta}"`
            : CTA_GUIDANCE[ctaStyle],
        capabilities,
        researchHook,
        length: LENGTH[stage] || LENGTH[CONVERSATION_STAGES.FIRST_OUTREACH],
        seed,
        personalizationReason: reasonParts.join(" "),
        avoid: {
            subjects: [...history.previousSubjects, ...orgRecent.map((item) => item.subject)].filter(Boolean).slice(-12),
            openings: [...history.previousOpenings, ...orgRecent.map((item) => item.opening)].filter(Boolean).slice(-12),
        },
    };
}

import { query } from "../../../config/db.js";
import { loadConversationHistory } from "../replyDrafter.service.js";
import { classifyInteractionIntent } from "../brain/intentClassification.service.js";

export const CONVERSATION_STAGES = Object.freeze({
    FIRST_OUTREACH: "FIRST_OUTREACH",
    FOLLOW_UP_NO_REPLY: "FOLLOW_UP_NO_REPLY",
    ANSWER_QUESTION: "ANSWER_QUESTION",
    CONTINUE_INTEREST: "CONTINUE_INTEREST",
    HANDLE_OBJECTION: "HANDLE_OBJECTION",
    CALLBACK_ACKNOWLEDGE: "CALLBACK_ACKNOWLEDGE",
    ACTIVE_CONVERSATION: "ACTIVE_CONVERSATION",
    OPTED_OUT: "OPTED_OUT",
    HUMAN_REQUIRED: "HUMAN_REQUIRED",
});

export const REPLY_STAGES = new Set([
    CONVERSATION_STAGES.ANSWER_QUESTION,
    CONVERSATION_STAGES.CONTINUE_INTEREST,
    CONVERSATION_STAGES.HANDLE_OBJECTION,
    CONVERSATION_STAGES.CALLBACK_ACKNOWLEDGE,
    CONVERSATION_STAGES.ACTIVE_CONVERSATION,
]);

const CALLBACK_PATTERN = /\b(call me|give me a call|ring me|call back|callback|phone me|reach me (on|at)|my number is)\b/i;
const INTEREST_PATTERN = /\b(interested|sounds (good|great|interesting)|tell me more|let'?s (talk|connect|chat)|happy to (talk|chat|connect)|book a (demo|call)|set up a (demo|call)|send (me )?(more )?(details|info))\b/i;
const OBJECTION_PATTERN = /\b(not interested|no thanks|not (a|the) (priority|right time)|no budget|too expensive|already (use|using|have|work with)|we (use|have) (an?|our own)|not now|maybe later|happy with (our|the) current|don'?t need)\b/i;
const QUESTION_PATTERN = /\?|\b(how (does|do|much|long)|what (is|are|does)|can (it|you)|does (it|nova)|do you (support|integrate|offer)|is there)\b/i;

const INTENT_STAGE = {
    OPT_OUT: CONVERSATION_STAGES.OPTED_OUT,
    COMPLAINT: CONVERSATION_STAGES.HUMAN_REQUIRED,
    CALLBACK_REQUEST: CONVERSATION_STAGES.CALLBACK_ACKNOWLEDGE,
    PRICING_QUERY: CONVERSATION_STAGES.ANSWER_QUESTION,
    PRODUCT_QUESTION: CONVERSATION_STAGES.ANSWER_QUESTION,
    INTERESTED: CONVERSATION_STAGES.CONTINUE_INTEREST,
    MEETING_REQUEST: CONVERSATION_STAGES.CONTINUE_INTEREST,
    NOT_INTERESTED: CONVERSATION_STAGES.HANDLE_OBJECTION,
};

export function classifyInboundStage(inbound) {
    if (!inbound) return null;
    const stored = String(inbound.intent || "").toUpperCase();
    const text = `${inbound.subject || ""}\n${inbound.text || inbound.body_text || ""}`;
    if (classifyInteractionIntent(text).intent === "unsubscribe_or_dnc") return CONVERSATION_STAGES.OPTED_OUT;
    if (INTENT_STAGE[stored]) return INTENT_STAGE[stored];
    if (CALLBACK_PATTERN.test(text)) return CONVERSATION_STAGES.CALLBACK_ACKNOWLEDGE;
    if (OBJECTION_PATTERN.test(text)) return CONVERSATION_STAGES.HANDLE_OBJECTION;
    if (QUESTION_PATTERN.test(text)) return CONVERSATION_STAGES.ANSWER_QUESTION;
    if (INTEREST_PATTERN.test(text)) return CONVERSATION_STAGES.CONTINUE_INTEREST;
    return CONVERSATION_STAGES.ACTIVE_CONVERSATION;
}

function toTime(value) {
    const time = value ? new Date(value).getTime() : NaN;
    return Number.isNaN(time) ? 0 : time;
}

export function deriveConversationStage({ lead = {}, items = [], latestInbound = null } = {}) {
    if (lead.do_not_contact || String(lead.status || "").toUpperCase() === "SUPPRESSED_DNC") return CONVERSATION_STAGES.OPTED_OUT;
    const outbound = items.filter((item) => item.direction === "OUTBOUND");
    const inbound = items.filter((item) => item.direction === "INBOUND");
    const lastOutboundAt = Math.max(0, ...outbound.map((item) => toTime(item.at)));
    const newestInbound = latestInbound || inbound[inbound.length - 1] || null;
    if (newestInbound) {
        const stage = classifyInboundStage(newestInbound);
        if (stage === CONVERSATION_STAGES.OPTED_OUT || stage === CONVERSATION_STAGES.HUMAN_REQUIRED) return stage;
        if (toTime(newestInbound.at || newestInbound.received_at) >= lastOutboundAt) return stage;
        return CONVERSATION_STAGES.ACTIVE_CONVERSATION;
    }
    return outbound.length ? CONVERSATION_STAGES.FOLLOW_UP_NO_REPLY : CONVERSATION_STAGES.FIRST_OUTREACH;
}

function openingOf(text) {
    const body = String(text || "")
        .replace(/\r\n/g, "\n")
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter((part) => part && !/^(hi|hello|dear)\b[^\n]{0,40},?$/i.test(part));
    const first = body[0] || "";
    const match = /^(.+?[.!?])(\s|$)/.exec(first);
    return (match ? match[1] : first).slice(0, 240);
}

export function summarizeHistory({ lead = {}, items = [], latestInbound = null, sentOutreach = [], callsConnected = 0 } = {}) {
    const merged = [...items];
    for (const sent of sentOutreach) {
        if (!sent?.sent_at) continue;
        const duplicate = merged.some((item) => item.direction === "OUTBOUND"
            && String(item.subject || "") === String(sent.subject || "")
            && Math.abs(toTime(item.at) - toTime(sent.sent_at)) < 10 * 60 * 1000);
        if (!duplicate) merged.push({ direction: "OUTBOUND", subject: sent.subject || "", text: sent.text || "", at: new Date(sent.sent_at).toISOString(), capabilities: sent.capabilities || [], angle: sent.angle || null });
    }
    merged.sort((a, b) => toTime(a.at) - toTime(b.at));
    const outbound = merged.filter((item) => item.direction === "OUTBOUND");
    const inbound = merged.filter((item) => item.direction === "INBOUND");
    const latest = latestInbound
        ? { ...latestInbound, text: latestInbound.text || latestInbound.body_text || "", at: latestInbound.at || latestInbound.received_at }
        : (inbound[inbound.length - 1] || null);
    const stage = deriveConversationStage({ lead, items: merged, latestInbound: latest });
    const lastInteraction = merged[merged.length - 1]?.at || null;
    return {
        stage,
        items: merged.slice(-8),
        outboundCount: outbound.length,
        inboundCount: inbound.length,
        followUpCount: Math.max(0, outbound.length - 1),
        latestInbound: latest ? { subject: latest.subject || "", text: String(latest.text || "").slice(0, 1500), intent: latest.intent || null, at: latest.at || null } : null,
        lastInteractionAt: lastInteraction,
        callsConnected: Number(callsConnected || 0),
        hasSpokenWithProspect: Number(callsConnected || 0) > 0,
        previousSubjects: outbound.map((item) => item.subject).filter(Boolean),
        previousBodies: outbound.map((item) => item.text).filter(Boolean),
        previousOpenings: outbound.map((item) => openingOf(item.text)).filter(Boolean),
        previousCapabilities: [...new Set(sentOutreach.flatMap((item) => item.capabilities || []))],
        previousAngles: [...new Set(sentOutreach.map((item) => item.angle).filter(Boolean))],
        previousHooks: sentOutreach.map((item) => item.hook).filter(Boolean),
    };
}

export async function loadCommunicationHistory(lead, { sentOutreach = [] } = {}) {
    const orgId = Number(lead?.organization_id || 1);
    const leadId = Number(lead?.id || 0);
    if (!leadId) return summarizeHistory({ lead, sentOutreach });
    const [items, latestRows, callRows] = await Promise.all([
        loadConversationHistory(orgId, leadId, { limit: 10 }).catch(() => []),
        query(
            `SELECT subject, body_text, intent, received_at FROM inbound_emails
             WHERE organization_id = ? AND lead_id = ? ORDER BY received_at DESC LIMIT 1`,
            [orgId, leadId]
        ).catch(() => []),
        query(
            `SELECT COUNT(*) AS c FROM calls WHERE organization_id = ? AND lead_id = ? AND is_answered = 1`,
            [orgId, leadId]
        ).catch(() => []),
    ]);
    const latest = latestRows?.[0]
        ? { subject: latestRows[0].subject, text: latestRows[0].body_text || "", intent: latestRows[0].intent, at: latestRows[0].received_at }
        : null;
    return summarizeHistory({ lead, items, latestInbound: latest, sentOutreach, callsConnected: callRows?.[0]?.c || 0 });
}

export { openingOf };

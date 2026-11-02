import crypto from "crypto";
import { getOpenAiClient } from "../../controllers/OpenAI/client.js";
import { InboundEmail } from "../../models/inbound-email.model.js";
import { EmailReplyDraft } from "../../models/email-reply-draft.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { REPLY_DRAFT_STATUSES as S, REPLY_INTENTS, REPLY_ROUTES } from "../../schema/inbound-email.schema.js";
import { getIo } from "../../socket/socketServer.js";
import { unifiedDeliveryService } from "../email/unifiedDelivery.service.js";
import { ASE_ADMIN_ROLES, roleAllowed } from "./roles.constants.js";
import { ASE_OUTCOMES } from "./outcomeNormalizer.service.js";
import { classifyReplyIntent, classifyReplyIntentWithModel, REVIEW_FLAGS } from "./replyIntent.service.js";
import {
    draftStatusFor,
    generateReplyDraft,
    guardReplyDraft,
    loadConversationHistory,
    sellerFactsFromPlaybook,
    textToHtml,
    verifiedResearchFacts,
} from "./replyDrafter.service.js";
import { getActivePlaybook } from "./salesPlaybook.service.js";
import { transitionLeadState } from "./leadStateMachine.js";

const REVIEWABLE = [S.PENDING_APPROVAL, S.NEEDS_HUMAN_REVIEW];
const SENSITIVE_FLAGS = new Set([REVIEW_FLAGS.COMPLAINT, REVIEW_FLAGS.LEGAL]);

function isTestRun() {
    return process.env.NODE_ENV === "test" || typeof process.env.NODE_TEST_CONTEXT !== "undefined";
}

function httpError(status, message, code) {
    return Object.assign(new Error(message), { status, code });
}

function parseMetadata(lead) {
    if (!lead?.metadata) return {};
    if (typeof lead.metadata === "object") return lead.metadata;
    try {
        return JSON.parse(lead.metadata);
    } catch {
        return {};
    }
}

/** Stable id for messages that arrive without a Message-ID so a retried webhook maps to the same row. */
export function deriveMessageId({ messageId, from, subject, body, date, leadId } = {}) {
    const clean = String(messageId || "").trim();
    if (clean) return clean.slice(0, 255);
    const day = date ? new Date(date).toISOString() : "";
    const digest = crypto
        .createHash("sha256")
        .update([leadId || "", String(from || "").toLowerCase(), subject || "", String(body || "").trim(), day].join("\u0001"))
        .digest("hex");
    return `derived_${digest.slice(0, 40)}`;
}

function classificationFromOutcome(outcome, body, subject) {
    const base = classifyReplyIntent(body, { subject });
    if (outcome === ASE_OUTCOMES.DNC && base.intent !== REPLY_INTENTS.OPT_OUT) {
        return { ...base, intent: REPLY_INTENTS.OPT_OUT, route: REPLY_ROUTES.SUPPRESS, outcome, method: "outcome" };
    }
    if (outcome === ASE_OUTCOMES.OOO) return { ...base, route: REPLY_ROUTES.NO_REPLY, outcome, method: base.method };
    if (outcome === ASE_OUTCOMES.NOT_INTERESTED && base.intent !== REPLY_INTENTS.OPT_OUT) {
        return { ...base, intent: REPLY_INTENTS.NOT_INTERESTED, route: REPLY_ROUTES.NO_REPLY, outcome, method: "outcome" };
    }
    return base;
}

export async function classifyInboundReply(body, { subject = "", useModel = !isTestRun() } = {}) {
    const client = useModel ? getOpenAiClient() : null;
    return client ? classifyReplyIntentWithModel(body, { subject, client }) : classifyReplyIntent(body, { subject });
}

/** Records the inbound message exactly once. `duplicate: true` means this message was already processed. */
export async function recordInboundReply({ lead, orgId, message, classification, match = {}, enrollment = null }) {
    const messageId = deriveMessageId({ ...message, leadId: lead.id });
    const recorded = await InboundEmail.recordOnce({
        organization_id: orgId,
        lead_id: lead.id,
        enrollment_id: enrollment?.id || null,
        campaign_id: enrollment?.campaign_id || null,
        message_id: messageId,
        in_reply_to: message.inReplyTo || null,
        references: message.references || [],
        from_email: message.from || lead.email,
        to_email: message.to || null,
        subject: message.subject || "",
        body_text: message.body || "",
        received_at: message.date || new Date(),
        matched_by: match.matchedBy || null,
        intent: classification.intent,
        intent_confidence: classification.confidence ?? null,
        intent_method: classification.method || null,
        route: classification.route,
        review_flags: classification.reviewFlags || [],
        status: "RECEIVED",
    });
    return { ...recorded, messageId, duplicate: !recorded.created };
}

/** Valid opt-out: suppress every channel immediately and cancel anything queued, including unsent reply drafts. */
export async function applyOptOut(lead, orgId, { inboundId = null, reason = "Prospect opted out by email reply" } = {}) {
    if (lead.email) await Suppression.add(orgId, { type: "EMAIL", email: lead.email, reason: "UNSUBSCRIBE_REPLY" });
    if (lead.phone) await Suppression.add(orgId, { type: "PHONE", value: lead.phone, reason: "UNSUBSCRIBE_REPLY" });
    const transition = transitionLeadState(lead.status, "SUPPRESS_DNC", { reason });
    await Lead.updateById(lead.id, { do_not_contact: 1, status: transition.nextState, next_action: null, next_action_time: null }, orgId);
    const cancelledDrafts = await EmailReplyDraft.cancelOpenForLead(orgId, lead.id, reason);
    const { haltOutreachForLead } = await import("./outreachHalt.service.js");
    await haltOutreachForLead(orgId, lead.id, reason).catch(() => null);
    if (inboundId) await InboundEmail.updateStatus(orgId, inboundId, "SUPPRESSED").catch(() => {});
    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        channel: "EMAIL",
        event_type: "OPT_OUT_SUPPRESSED",
        status: "SUPPRESSED",
        payload: { reason, inboundEmailId: inboundId, cancelledDrafts, channels: ["EMAIL", ...(lead.phone ? ["PHONE"] : [])] },
        idempotency_key: `opt_out_${orgId}_${lead.id}_${inboundId || "direct"}`,
    }).catch(() => {});
    return { suppressed: true, cancelledDrafts };
}

async function buildDraftContext(lead, orgId, inboundId) {
    const [playbook, history] = await Promise.all([
        getActivePlaybook(orgId).catch(() => null),
        loadConversationHistory(orgId, lead.id, { excludeInboundId: inboundId }).catch(() => []),
    ]);
    const research = verifiedResearchFacts(parseMetadata(lead).company_research);
    return { seller: sellerFactsFromPlaybook(playbook), research, history };
}

/** Creates the approval-queue draft for an inbound message (idempotent). Never sends. */
export async function createReplyDraft({ lead, orgId, inbound, classification, client = undefined }) {
    if (classification.route === REPLY_ROUTES.SUPPRESS || classification.route === REPLY_ROUTES.NO_REPLY) {
        await InboundEmail.updateStatus(orgId, inbound.id, classification.route === REPLY_ROUTES.SUPPRESS ? "SUPPRESSED" : "NO_REPLY_NEEDED").catch(() => {});
        await LeadEvent.create({
            organization_id: orgId,
            lead_id: lead.id,
            channel: "EMAIL",
            event_type: "REPLY_NOT_DRAFTED",
            status: classification.route,
            payload: { inboundEmailId: inbound.id, intent: classification.intent, reason: classification.route === REPLY_ROUTES.SUPPRESS ? "Opt-out: no sales reply is ever sent" : "No reply needed for this intent" },
            idempotency_key: `reply_not_drafted_${orgId}_${inbound.id}`,
        }).catch(() => {});
        return { created: false, draft: null, skipped: classification.route };
    }

    const existing = await EmailReplyDraft.findByInbound(orgId, inbound.id);
    if (existing) return { created: false, draft: existing };

    const context = await buildDraftContext(lead, orgId, inbound.id);
    const modelClient = client === undefined ? (isTestRun() ? null : getOpenAiClient()) : client;
    const generated = await generateReplyDraft({ lead, inbound, classification, ...context, client: modelClient });
    const status = draftStatusFor({ route: classification.route, guardIssues: generated.guardIssues, needsHumanInput: generated.needsHumanInput, text: generated.text });
    const reasons = [
        classification.route === REPLY_ROUTES.HUMAN_REVIEW ? `Sensitive reply (${(classification.reviewFlags || []).join(", ") || classification.intent})` : null,
        generated.guardIssues.length ? `Guard: ${generated.guardIssues.join(", ")}` : null,
        generated.needsHumanInput.length ? `Needs input: ${generated.needsHumanInput.join(", ")}` : null,
    ].filter(Boolean);

    const result = await EmailReplyDraft.createOnce({
        organization_id: orgId,
        lead_id: lead.id,
        inbound_email_id: inbound.id,
        intent: classification.intent,
        status,
        subject: generated.subject,
        body_text: generated.text,
        body_html: generated.html,
        generation_method: generated.method,
        grounding: { ...generated.grounding, needsHumanInput: generated.needsHumanInput, reviewFlags: classification.reviewFlags || [] },
        guard_issues: generated.guardIssues,
        review_reason: reasons.join(" · ") || null,
    });

    if (result.created) {
        await InboundEmail.updateStatus(orgId, inbound.id, "DRAFTED").catch(() => {});
        await LeadEvent.create({
            organization_id: orgId,
            lead_id: lead.id,
            user_id: lead.user_id || null,
            channel: "EMAIL",
            event_type: "AI_RESPONSE_DRAFTED",
            status,
            payload: {
                draftId: result.draft.id,
                inboundEmailId: inbound.id,
                intent: classification.intent,
                subject: result.draft.subject,
                bodyText: result.draft.body_text,
                bodyHtml: result.draft.body_html,
                guardIssues: generated.guardIssues,
                requiresApproval: true,
            },
            idempotency_key: `reply_draft_${orgId}_${inbound.id}`,
        }).catch(() => {});
        getIo()?.to(`org:${orgId}`).emit("reply_draft:created", { draftId: result.draft.id, leadId: lead.id, status, intent: classification.intent });
    }
    return result;
}

/**
 * Entry point for code paths that only have the reply payload (e.g. direct follow-up engine calls):
 * classifies, records once, applies opt-out, and queues a draft.
 */
export async function ingestReply(lead, payload = {}, { enrollment = null, match = {} } = {}) {
    const orgId = Number(lead.organization_id || 1);
    const body = payload.replyText || payload.body || "";
    const subject = payload.subject || "";
    const classification = payload.classification || classificationFromOutcome(payload.outcome, body, subject);
    let inbound = payload.inboundEmailId ? await InboundEmail.findById(orgId, payload.inboundEmailId) : null;
    let duplicate = false;
    if (!inbound) {
        const recorded = await recordInboundReply({
            lead,
            orgId,
            message: { messageId: payload.messageId, from: payload.from || lead.email, to: payload.to, subject, body, inReplyTo: payload.inReplyTo, references: payload.references, date: payload.date },
            classification,
            match,
            enrollment,
        });
        inbound = recorded.inbound;
        duplicate = recorded.duplicate;
    }
    if (!inbound) return { inbound: null, draft: null, classification, duplicate };
    if (classification.intent === REPLY_INTENTS.OPT_OUT) await applyOptOut(lead, orgId, { inboundId: inbound.id });
    if (duplicate) return { inbound, draft: await EmailReplyDraft.findByInbound(orgId, inbound.id), classification, duplicate };
    const meeting = await applyReplyHandoff(lead, orgId, inbound, classification);
    const drafted = await createReplyDraft({ lead, orgId, inbound, classification });
    return { inbound, draft: drafted.draft, classification, duplicate, meeting };
}

const INTEREST_INTENTS = new Set([REPLY_INTENTS.INTERESTED, REPLY_INTENTS.PRICING_QUERY, REPLY_INTENTS.PRODUCT_QUESTION]);

/** A reply can open a meeting request or mark interest; it never marks a meeting booked. */
async function applyReplyHandoff(lead, orgId, inbound, classification) {
    try {
        if (classification.intent === REPLY_INTENTS.MEETING_REQUEST) {
            const { requestMeeting } = await import("./meetingBooking.service.js");
            const snippet = String(inbound.body_text || "").replace(/\s+/g, " ").trim().slice(0, 300);
            const { meeting } = await requestMeeting(orgId, lead.id, {
                source: "EMAIL",
                sourceRef: `inbound_${inbound.id}`,
                preferredText: snippet ? `Prospect email: "${snippet}"` : "Prospect asked for a meeting by email",
            });
            return meeting;
        }
        const { HANDOFF_STATUSES, setHandoffStatus } = await import("./handoffStatus.service.js");
        if (classification.intent === REPLY_INTENTS.CALLBACK_REQUEST) {
            await setHandoffStatus(lead, HANDOFF_STATUSES.HANDOFF_REQUESTED, { orgId, source: "EMAIL", reason: "Prospect asked for a call by email" });
        } else if (INTEREST_INTENTS.has(classification.intent)) {
            await setHandoffStatus(lead, HANDOFF_STATUSES.INTERESTED, { orgId, source: "EMAIL", reason: `Email reply intent ${classification.intent}` });
        }
    } catch (err) {
        console.warn("[ReplyApproval] handoff update failed:", err.message);
    }
    return null;
}

function assertHumanReviewer(user, draft) {
    if (!user?.id || user.authVia !== "user_jwt" || String(user.role || "").toUpperCase() === "SYSTEM_AGENT") {
        throw httpError(403, "Reply drafts can only be approved or sent by a signed-in team member", "HUMAN_APPROVAL_REQUIRED");
    }
    const flags = draft?.grounding?.reviewFlags || [];
    if (flags.some((flag) => SENSITIVE_FLAGS.has(flag)) && !roleAllowed(user.role, ASE_ADMIN_ROLES)) {
        throw httpError(403, "Complaint and legal replies need a manager or admin", "SENSITIVE_REVIEW_ROLE");
    }
}

async function audit(orgId, draft, user, eventType, status, extra = {}) {
    await LeadEvent.create({
        organization_id: orgId,
        lead_id: draft.lead_id,
        user_id: user?.id && /^\d+$/.test(String(user.id)) ? Number(user.id) : null,
        channel: "EMAIL",
        event_type: eventType,
        status,
        payload: { draftId: draft.id, inboundEmailId: draft.inbound_email_id, actor: user?.email || user?.id || null, ...extra },
    }).catch(() => {});
    getIo()?.to(`org:${orgId}`).emit("reply_draft:updated", { draftId: draft.id, leadId: draft.lead_id, status });
}

async function loadDraft(orgId, draftId) {
    const draft = await EmailReplyDraft.findById(orgId, draftId);
    if (!draft) throw httpError(404, "Reply draft not found", "NOT_FOUND");
    return draft;
}

async function assertLeadContactable(orgId, draft) {
    const lead = await Lead.findById(draft.lead_id, orgId);
    if (!lead) throw httpError(404, "Lead not found", "NOT_FOUND");
    if (lead.do_not_contact) throw httpError(409, "Lead is Do Not Contact; this reply cannot be sent", "LEAD_SUPPRESSED");
    const domain = lead.email ? lead.email.split("@")[1] : null;
    if (await Suppression.isSuppressed(orgId, { email: lead.email, domain })) {
        throw httpError(409, "Recipient is on the suppression list", "LEAD_SUPPRESSED");
    }
    return lead;
}

export async function getReplyDraft(orgId, draftId) {
    const draft = await loadDraft(orgId, draftId);
    const inbound = await InboundEmail.findById(orgId, draft.inbound_email_id);
    return { draft, inbound };
}

export async function listReplyDrafts(orgId, { status = null, leadId = null, limit, offset } = {}) {
    const statuses = status
        ? String(status).split(",").map((value) => value.trim().toUpperCase()).filter((value) => Object.values(S).includes(value))
        : [S.PENDING_APPROVAL, S.NEEDS_HUMAN_REVIEW, S.APPROVED, S.SEND_FAILED, S.SEND_UNKNOWN];
    const [drafts, counts] = await Promise.all([
        EmailReplyDraft.list(orgId, { statuses, leadId, limit, offset }),
        EmailReplyDraft.countByStatus(orgId),
    ]);
    return { drafts, counts };
}

export async function editReplyDraft(orgId, draftId, user, { subject, bodyText }) {
    const draft = await loadDraft(orgId, draftId);
    assertHumanReviewer(user, draft);
    const nextSubject = String(subject ?? draft.subject ?? "").trim();
    const nextBody = String(bodyText ?? draft.body_text ?? "").trim();
    if (!nextSubject || !nextBody) throw httpError(400, "Subject and body are required", "MISSING_FIELDS");
    if (nextSubject.length > 200) throw httpError(400, "Subject is too long", "SUBJECT_TOO_LONG");

    const lead = await Lead.findById(draft.lead_id, orgId);
    const inbound = await InboundEmail.findById(orgId, draft.inbound_email_id);
    const context = await buildDraftContext(lead || { id: draft.lead_id }, orgId, draft.inbound_email_id);
    const guardIssues = guardReplyDraft({ subject: nextSubject, text: nextBody }, { ...context, inbound });
    const sensitive = (draft.grounding?.reviewFlags || []).length > 0;
    const status = sensitive || guardIssues.length ? S.NEEDS_HUMAN_REVIEW : S.PENDING_APPROVAL;
    const updated = await EmailReplyDraft.transition(orgId, draftId, [...REVIEWABLE, S.APPROVED, S.SEND_FAILED], status, {
        subject: nextSubject,
        body_text: nextBody,
        body_html: textToHtml(nextBody),
        edited: true,
        edited_by: Number(user.id),
        edited_at: new Date(),
        reviewed_by: null,
        reviewed_at: null,
        guard_issues: guardIssues,
    });
    if (!updated) throw httpError(409, `Draft cannot be edited while ${draft.status}`, "INVALID_STATE");
    await audit(orgId, updated, user, "REPLY_DRAFT_EDITED", status, { guardIssues, previousStatus: draft.status });
    return updated;
}

export async function approveReplyDraft(orgId, draftId, user, { acknowledgeIssues = false } = {}) {
    const draft = await loadDraft(orgId, draftId);
    assertHumanReviewer(user, draft);
    if (!String(draft.body_text || "").trim()) throw httpError(400, "Write the reply before approving it", "EMPTY_DRAFT");
    if ((draft.guard_issues || []).length && !acknowledgeIssues) {
        throw httpError(409, `Draft has unresolved guard issues: ${draft.guard_issues.join(", ")}. Edit it or approve with acknowledgeIssues.`, "GUARD_ISSUES");
    }
    await assertLeadContactable(orgId, draft);
    const updated = await EmailReplyDraft.transition(orgId, draftId, REVIEWABLE, S.APPROVED, {
        reviewed_by: Number(user.id),
        reviewed_at: new Date(),
    });
    if (!updated) {
        const current = await loadDraft(orgId, draftId);
        if (current.status === S.APPROVED) return current;
        throw httpError(409, `Draft cannot be approved while ${current.status}`, "INVALID_STATE");
    }
    await audit(orgId, updated, user, "REPLY_DRAFT_APPROVED", S.APPROVED, { acknowledgedIssues: acknowledgeIssues ? draft.guard_issues : [] });
    return updated;
}

export async function rejectReplyDraft(orgId, draftId, user, { reason = "" } = {}) {
    const draft = await loadDraft(orgId, draftId);
    if (!user?.id || user.authVia !== "user_jwt") throw httpError(403, "Only a signed-in team member can reject drafts", "HUMAN_APPROVAL_REQUIRED");
    const updated = await EmailReplyDraft.transition(orgId, draftId, [...REVIEWABLE, S.APPROVED, S.SEND_FAILED, S.SEND_UNKNOWN], S.REJECTED, {
        reject_reason: String(reason || "Rejected by reviewer").slice(0, 500),
        reviewed_by: Number(user.id),
        reviewed_at: new Date(),
    });
    if (!updated) {
        const current = await loadDraft(orgId, draftId);
        if (current.status === S.REJECTED) return current;
        throw httpError(409, `Draft cannot be rejected while ${current.status}`, "INVALID_STATE");
    }
    await audit(orgId, updated, user, "REPLY_DRAFT_REJECTED", S.REJECTED, { reason: updated.reject_reason });
    return updated;
}

/**
 * Sends an APPROVED draft once. The APPROVED -> SENDING compare-and-set means concurrent clicks or retries
 * cannot send twice; an ambiguous SMTP result is parked as SEND_UNKNOWN and needs an explicit confirmResend.
 */
export async function sendReplyDraft(orgId, draftId, user, { confirmResend = false, deliver = unifiedDeliveryService.deliverSingle.bind(unifiedDeliveryService) } = {}) {
    const draft = await loadDraft(orgId, draftId);
    assertHumanReviewer(user, draft);
    if (draft.status === S.SENT) return { draft, alreadySent: true };
    const from = [S.APPROVED, S.SEND_FAILED, ...(confirmResend ? [S.SEND_UNKNOWN] : [])];
    if (!from.includes(draft.status)) {
        const hint = draft.status === S.SEND_UNKNOWN ? " The previous attempt may have been delivered; resend with confirmResend only after checking the mailbox." : "";
        throw httpError(409, `Draft must be approved before sending (current status ${draft.status}).${hint}`, "NOT_APPROVED");
    }
    if (!draft.reviewed_by) throw httpError(409, "Draft has no recorded approval", "NOT_APPROVED");
    const lead = await assertLeadContactable(orgId, draft);
    const inbound = await InboundEmail.findById(orgId, draft.inbound_email_id);
    if (inbound?.intent === REPLY_INTENTS.OPT_OUT) throw httpError(409, "Sales replies are never sent to an opt-out", "OPT_OUT");

    const claimed = await EmailReplyDraft.transition(orgId, draftId, from, S.SENDING, { send_attempts: Number(draft.send_attempts || 0) + 1 });
    if (!claimed) {
        const current = await loadDraft(orgId, draftId);
        if (current.status === S.SENT || current.status === S.SENDING) return { draft: current, alreadySent: current.status === S.SENT, inProgress: current.status === S.SENDING };
        throw httpError(409, `Draft cannot be sent while ${current.status}`, "INVALID_STATE");
    }

    const headers = {};
    if (inbound?.message_id && !String(inbound.message_id).startsWith("derived_")) {
        headers["In-Reply-To"] = inbound.message_id;
        headers.References = [...(inbound.references_json || []), inbound.message_id].join(" ");
    }
    let delivery;
    try {
        delivery = await deliver({
            orgId,
            to: lead.email,
            subject: claimed.subject,
            text: claimed.body_text,
            html: claimed.body_html || textToHtml(claimed.body_text),
            headers,
            leadId: lead.id,
            idempotencyKey: `reply_draft_${orgId}_${draftId}`,
        });
    } catch (error) {
        delivery = { status: "UNKNOWN", error: error.message };
    }

    let next;
    if (delivery?.status === "SUCCEEDED") {
        next = await EmailReplyDraft.transition(orgId, draftId, [S.SENDING], S.SENT, {
            sent_message_id: delivery.messageId || null,
            sent_at: new Date(),
            send_error: null,
        });
        await InboundEmail.updateStatus(orgId, draft.inbound_email_id, "REPLIED").catch(() => {});
        await audit(orgId, next, user, "AI_RESPONSE_SENT", S.SENT, { messageId: delivery.messageId || null, subject: next.subject, bodyText: next.body_text, approvedBy: next.reviewed_by });
        await Lead.updateById(lead.id, { last_contacted_at: new Date() }, orgId).catch(() => {});
    } else {
        const ambiguous = delivery?.status === "UNKNOWN" || delivery?.ambiguous;
        const status = ambiguous ? S.SEND_UNKNOWN : S.SEND_FAILED;
        const error = String(delivery?.error || delivery?.skipReason || delivery?.status || "Delivery failed").slice(0, 1000);
        next = await EmailReplyDraft.transition(orgId, draftId, [S.SENDING], status, { send_error: error });
        await audit(orgId, next, user, "AI_RESPONSE_FAILED", status, { error });
    }
    return { draft: next, delivery: { status: delivery?.status, messageId: delivery?.messageId || null } };
}

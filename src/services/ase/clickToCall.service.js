import { query } from "../../config/db.js";
import { Call } from "../../models/call.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { TelephonyWebhookEvent } from "../../models/telephony-webhook-event.model.js";
import { plivoVoiceAdapter } from "./adapters/plivoVoice.adapter.js";
import { eventBus } from "./eventBus.service.js";
import { resolveRepTransferPhone } from "./warmTransfer.service.js";
import { schedulePlivoCallSync } from "./plivoCallPoll.service.js";
import { normalizeConsentStatus, CONSENT_STATUSES } from "./consent.service.js";
import {
    CLICK_TO_CALL_LABELS,
    CLICK_TO_CALL_OPEN_STATUSES,
    CLICK_TO_CALL_REUSE_WINDOW_MS,
    CLICK_TO_CALL_SOURCE,
    CLICK_TO_CALL_STATES,
    CLICK_TO_CALL_TERMINAL,
} from "./clickToCall.constants.js";

const inFlightByLead = new Map();

export function toE164(phone) {
    const raw = String(phone || "").trim();
    if (!raw) return "";
    let digits = raw.replace(/[^\d+]/g, "");
    if (digits.startsWith("0") && digits.length === 11) digits = "+91" + digits.slice(1);
    else if (!digits.startsWith("+") && digits.length === 10 && /^[6-9]/.test(digits)) digits = "+91" + digits;
    else if (!digits.startsWith("+") && digits.length === 12 && digits.startsWith("91")) digits = "+" + digits;
    const only = digits.replace(/[^\d]/g, "");
    return only.length >= 10 && only.length <= 15 ? digits : "";
}

export function parseCallMeta(value) {
    if (!value) return {};
    if (typeof value === "object") return { ...value };
    try {
        return JSON.parse(value) || {};
    } catch {
        return {};
    }
}

function parseSettings(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
}

function httpError(message, status) {
    return Object.assign(new Error(message), { status });
}

function ringTimeoutSec() {
    const n = Number(process.env.CLICK_TO_CALL_RING_TIMEOUT_SEC || 45);
    return Number.isFinite(n) ? Math.min(Math.max(n, 10), 120) : 45;
}

export function isClickToCallRecord(call) {
    if (!call) return false;
    if (String(call.initiation_source || "") === CLICK_TO_CALL_SOURCE) return true;
    return parseCallMeta(call.raw_metadata).mode === "click_to_call";
}

export function emptyClickToCallSession(overrides = {}) {
    return {
        callId: null,
        leadId: null,
        state: CLICK_TO_CALL_STATES.IDLE,
        primaryPhone: "",
        leadPhone: "",
        primaryLegUuid: null,
        leadLegUuid: null,
        initiatedAt: null,
        primaryAnsweredAt: null,
        leadAnsweredAt: null,
        connectedAt: null,
        endedAt: null,
        connectedDurationSec: 0,
        leadCalled: false,
        failureReason: null,
        ...overrides,
    };
}

export function sessionFromCall(call) {
    if (!call) return emptyClickToCallSession();
    const meta = parseCallMeta(call.raw_metadata);
    const session = emptyClickToCallSession({
        callId: call.id || null,
        leadId: call.lead_id || null,
        state: meta.sessionState || CLICK_TO_CALL_STATES.INITIATING,
        primaryPhone: meta.primaryPhone || "",
        leadPhone: meta.leadPhone || call.phone_number || "",
        primaryLegUuid: meta.primaryLegUuid || call.provider_call_uuid || null,
        leadLegUuid: meta.leadLegUuid || null,
        initiatedAt: meta.initiatedAt || call.created_at || null,
        primaryAnsweredAt: meta.primaryAnsweredAt || null,
        leadAnsweredAt: meta.leadAnsweredAt || null,
        connectedAt: meta.connectedAt || null,
        endedAt: meta.endedAt || call.completed_at || null,
        connectedDurationSec: Number(meta.connectedDurationSec || 0),
        leadCalled: Boolean(meta.leadCalled),
        failureReason: call.failure_reason || meta.failureReason || null,
        label: CLICK_TO_CALL_LABELS[meta.sessionState] || CLICK_TO_CALL_LABELS.initiating,
    });
    session.label = CLICK_TO_CALL_LABELS[session.state] || session.state;
    return session;
}

export function reduceClickToCallEvent(session, event = {}) {
    const next = { ...emptyClickToCallSession(), ...session };
    const type = String(event.type || "");
    const now = event.at || new Date().toISOString();
    const alreadyTerminal = CLICK_TO_CALL_TERMINAL.has(next.state);

    if (alreadyTerminal && type !== "disconnected" && type !== "hangup") {
        return next;
    }

    const finish = (state, reason) => {
        next.state = state;
        next.endedAt = next.endedAt || now;
        if (reason) next.failureReason = reason;
    };

    if (type === "placed") {
        if (!alreadyTerminal) next.state = CLICK_TO_CALL_STATES.CALLING_YOU;
        next.primaryLegUuid = event.primaryLegUuid || next.primaryLegUuid;
        next.initiatedAt = next.initiatedAt || now;
        return next;
    }

    if (type === "primary_answered") {
        if (!alreadyTerminal) {
            next.state = CLICK_TO_CALL_STATES.CALLING_LEAD;
            next.leadCalled = true;
        }
        next.primaryAnsweredAt = next.primaryAnsweredAt || now;
        if (event.primaryLegUuid) next.primaryLegUuid = event.primaryLegUuid;
        return next;
    }

    if (type === "primary_no_answer" || type === "primary_busy" || type === "primary_failed" || type === "primary_rejected") {
        if (!next.primaryAnsweredAt && !alreadyTerminal) {
            const mapped =
                type === "primary_busy"
                    ? CLICK_TO_CALL_STATES.BUSY
                    : type === "primary_failed" || type === "primary_rejected"
                        ? CLICK_TO_CALL_STATES.FAILED
                        : CLICK_TO_CALL_STATES.NO_ANSWER;
            finish(mapped, event.reason || type);
            next.leadCalled = false;
        }
        return next;
    }

    if (type === "lead_answered") {
        if (!alreadyTerminal) next.state = CLICK_TO_CALL_STATES.CONNECTED;
        next.leadCalled = true;
        next.leadAnsweredAt = next.leadAnsweredAt || now;
        next.connectedAt = next.connectedAt || now;
        if (event.leadLegUuid) next.leadLegUuid = event.leadLegUuid;
        return next;
    }

    if (type === "lead_busy" || type === "lead_no_answer" || type === "lead_failed") {
        if (!alreadyTerminal) {
            const mapped =
                type === "lead_busy"
                    ? CLICK_TO_CALL_STATES.BUSY
                    : type === "lead_failed"
                        ? CLICK_TO_CALL_STATES.FAILED
                        : CLICK_TO_CALL_STATES.NO_ANSWER;
            finish(mapped, event.reason || type);
        }
        next.leadCalled = true;
        if (event.leadLegUuid) next.leadLegUuid = event.leadLegUuid;
        return next;
    }

    if (type === "disconnected" || type === "hangup") {
        if (alreadyTerminal) {
            if (event.durationSec) {
                next.connectedDurationSec = Math.max(next.connectedDurationSec || 0, Number(event.durationSec) || 0);
            }
            return next;
        }
        if (next.state === CLICK_TO_CALL_STATES.CONNECTED || next.connectedAt) {
            next.state = CLICK_TO_CALL_STATES.COMPLETED;
            next.endedAt = now;
            const fromConnected = next.connectedAt
                ? Math.max(0, Math.round((new Date(now).getTime() - new Date(next.connectedAt).getTime()) / 1000))
                : 0;
            next.connectedDurationSec = Math.max(next.connectedDurationSec || 0, Number(event.durationSec) || fromConnected);
            return next;
        }
        if (!next.primaryAnsweredAt) {
            finish(CLICK_TO_CALL_STATES.NO_ANSWER, event.reason || "primary_unanswered");
            next.leadCalled = false;
            return next;
        }
        if (next.state === CLICK_TO_CALL_STATES.CALLING_LEAD) {
            finish(CLICK_TO_CALL_STATES.NO_ANSWER, event.reason || "lead_unanswered");
            return next;
        }
        finish(CLICK_TO_CALL_STATES.COMPLETED, event.reason || type);
        return next;
    }

    return next;
}

export function classifyPrimaryHangup(payload = {}) {
    const status = String(payload.CallStatus || payload.call_status || payload.Status || "").toLowerCase();
    if (status === "busy") return "primary_busy";
    if (status === "no-answer" || status === "timeout") return "primary_no_answer";
    if (status === "failed" || status === "rejected" || status === "cancel" || status === "canceled" || status === "cancelled") {
        return "primary_failed";
    }
    return "disconnected";
}

export function classifyDialStatus(payload = {}) {
    const status = String(payload.DialStatus || payload.dial_status || payload.CallStatus || "").toLowerCase();
    const uuid = payload.DialBLegUUID || payload.dial_bleg_uuid || payload.CallUUID || null;
    if (status === "in-progress" || status === "answer" || status === "answered") {
        return { type: "lead_answered", leadLegUuid: uuid };
    }
    if (status === "busy") return { type: "lead_busy", leadLegUuid: uuid };
    if (status === "no-answer" || status === "timeout") return { type: "lead_no_answer", leadLegUuid: uuid };
    if (status === "failed" || status === "cancel" || status === "canceled" || status === "cancelled") {
        return { type: "lead_failed", leadLegUuid: uuid };
    }
    if (status === "completed") {
        const duration = Number(payload.DialDuration || payload.Duration || payload.RecordingDuration || 0);
        if (duration > 0) {
            return { type: "lead_answered", leadLegUuid: uuid, durationSec: duration, followedBy: "disconnected" };
        }
        return { type: "lead_no_answer", leadLegUuid: uuid };
    }
    return null;
}

export async function resolvePrimaryPhone({
    user = {},
    orgId = 1,
    assignedRepId = null,
    requestedPhone = "",
    loadSettings = null,
} = {}) {
    if (toE164(requestedPhone)) return toE164(requestedPhone);
    let settings = {};
    if (typeof loadSettings === "function") {
        settings = await loadSettings(orgId);
    } else {
        try {
            const rows = await query("SELECT settings FROM organizations WHERE id = ? LIMIT 1", [Number(orgId)]);
            settings = parseSettings(rows?.[0]?.settings);
        } catch {
            settings = {};
        }
    }
    const forUser = resolveRepTransferPhone({ userId: user.id, phone: user.phone }, settings);
    if (forUser) return forUser;
    if (assignedRepId) {
        const forRep = resolveRepTransferPhone({ userId: assignedRepId }, settings);
        if (forRep) return forRep;
    }
    return toE164(process.env.PLIVO_TRANSFER_NUMBER);
}

function voiceDenied(lead) {
    return normalizeConsentStatus(lead?.voice_consent?.status) === CONSENT_STATUSES.DENIED;
}

function domainFromEmail(email) {
    const value = String(email || "");
    const at = value.lastIndexOf("@");
    return at >= 0 ? value.slice(at + 1).toLowerCase() : "";
}

export function clickToCallAnswerXml({ leadNumber, callerId, timeout, dialCallbackUrl, leadName } = {}) {
    return plivoVoiceAdapter.generateClickToCallDialXml({
        leadNumber: toE164(leadNumber),
        callerId: callerId || process.env.PLIVO_PHONE_NUMBER,
        timeout: timeout || ringTimeoutSec(),
        dialCallbackUrl,
        leadName,
    });
}

function persistableMeta(session, extra = {}) {
    return {
        mode: "click_to_call",
        sessionState: session.state,
        primaryPhone: session.primaryPhone,
        leadPhone: session.leadPhone,
        primaryLegUuid: session.primaryLegUuid,
        leadLegUuid: session.leadLegUuid,
        initiatedAt: session.initiatedAt,
        primaryAnsweredAt: session.primaryAnsweredAt,
        leadAnsweredAt: session.leadAnsweredAt,
        connectedAt: session.connectedAt,
        endedAt: session.endedAt,
        connectedDurationSec: session.connectedDurationSec,
        leadCalled: session.leadCalled,
        failureReason: session.failureReason,
        ...extra,
    };
}

function outcomeForState(state) {
    if (state === CLICK_TO_CALL_STATES.CONNECTED) return "IN_PROGRESS";
    if (state === CLICK_TO_CALL_STATES.COMPLETED) return "COMPLETED";
    if (state === CLICK_TO_CALL_STATES.BUSY) return "BUSY";
    if (state === CLICK_TO_CALL_STATES.NO_ANSWER) return "NO_ANSWER";
    if (state === CLICK_TO_CALL_STATES.FAILED) return "FAILED";
    if (state === CLICK_TO_CALL_STATES.CALLING_LEAD || state === CLICK_TO_CALL_STATES.YOU_ANSWERED) return "IN_PROGRESS";
    return "INITIATED";
}

function providerStatusForState(state) {
    if (state === CLICK_TO_CALL_STATES.CONNECTED) return "in-progress";
    if (CLICK_TO_CALL_TERMINAL.has(state)) {
        if (state === CLICK_TO_CALL_STATES.BUSY) return "busy";
        if (state === CLICK_TO_CALL_STATES.NO_ANSWER) return "no-answer";
        if (state === CLICK_TO_CALL_STATES.FAILED) return "failed";
        return "completed";
    }
    if (state === CLICK_TO_CALL_STATES.CALLING_YOU) return "ringing";
    return "initiated";
}

async function emitSession(orgId, leadId, userId, session, eventType = "ClickToCallUpdated") {
    await eventBus.publish(eventType, {
        organization_id: orgId,
        lead_id: leadId,
        user_id: userId || null,
        channel: "VOICE",
        status: session.state,
        payload: {
            callId: session.callId,
            session,
            mode: "click_to_call",
        },
    }).catch(() => {});
}

async function saveSession(orgId, call, session, extra = {}, CallModel = Call) {
    const terminal = CLICK_TO_CALL_TERMINAL.has(session.state);
    const connected = session.state === CLICK_TO_CALL_STATES.CONNECTED || Boolean(session.connectedAt);
    const updates = {
        raw_metadata: persistableMeta(session, extra),
        provider_status: providerStatusForState(session.state),
        normalized_outcome: outcomeForState(session.state),
        failure_reason: session.failureReason || null,
    };
    if (session.primaryLegUuid) updates.provider_call_uuid = session.primaryLegUuid;
    if (connected) {
        updates.is_answered = 1;
        if (session.connectedAt) updates.answered_at = new Date(session.connectedAt);
        if (session.connectedDurationSec) updates.duration_sec = session.connectedDurationSec;
    }
    if (terminal) {
        updates.completed_at = session.endedAt ? new Date(session.endedAt) : new Date();
        if (session.connectedDurationSec) updates.duration_sec = session.connectedDurationSec;
    }
    return CallModel.updateById(orgId, call.id, updates);
}

export async function applyClickToCallEvent(orgId, call, event, deps = {}) {
    if (!call) return null;
    const CallModel = deps.Call || Call;
    const current = sessionFromCall(call);
    const next = reduceClickToCallEvent(current, event);
    const saved = await saveSession(orgId, call, next, { lastEvent: event.type }, CallModel);
    if (!deps.skipEmit) {
        await emitSession(orgId, call.lead_id, null, { ...next, callId: call.id });
    }
    return { call: saved, session: next };
}

export async function applyClickToCallProviderStatus(rawPayload = {}) {
    const payload = { ...(rawPayload || {}) };
    const callUuid = payload.CallUUID || payload.CallId || payload.request_uuid || payload.DialBLegUUID;
    let call = payload.callId
        ? await Call.findByIdAnyOrg(payload.callId).catch(() => null)
        : null;
    if (!call && callUuid) {
        call = await Call.findByProviderUuidAnyOrg(callUuid);
    }
    if (!call && payload.leadLegUuid) {
        const rows = await query(
            `SELECT id FROM calls WHERE JSON_UNQUOTE(JSON_EXTRACT(raw_metadata, '$.leadLegUuid')) = ? LIMIT 1`,
            [String(payload.leadLegUuid)]
        ).catch(() => []);
        if (rows?.[0]?.id) call = await Call.findByIdAnyOrg(rows[0].id);
    }
    if (!call || !isClickToCallRecord(call)) return { ignored: true };
    const orgId = Number(call.organization_id || payload.orgId || 1);
    const session = sessionFromCall(call);
    if (!session.primaryAnsweredAt) {
        const type = classifyPrimaryHangup(payload);
        return applyClickToCallEvent(orgId, call, {
            type,
            at: payload.EndTime || new Date().toISOString(),
            reason: payload.HangupCause || payload.CallStatus,
            primaryLegUuid: payload.CallUUID,
            durationSec: Number(payload.Duration || 0),
        });
    }
    const dial = classifyDialStatus(payload);
    if (dial) {
        const first = await applyClickToCallEvent(orgId, call, {
            type: dial.type,
            at: payload.AnswerTime || new Date().toISOString(),
            leadLegUuid: dial.leadLegUuid,
            durationSec: dial.durationSec,
        });
        if (dial.followedBy === "disconnected") {
            const refreshed = first?.call || call;
            return applyClickToCallEvent(orgId, refreshed, {
                type: "disconnected",
                at: payload.EndTime || new Date().toISOString(),
                durationSec: Number(payload.DialDuration || payload.Duration || dial.durationSec || 0),
            });
        }
        return first;
    }
    return applyClickToCallEvent(orgId, call, {
        type: classifyPrimaryHangup(payload),
        at: payload.EndTime || new Date().toISOString(),
        durationSec: Number(payload.Duration || 0),
        reason: payload.HangupCause || payload.CallStatus,
    });
}

async function validateLeadForClickToCall(lead, orgId, deps = {}) {
    if (!lead) throw httpError("Lead not found", 404);
    if (lead.do_not_contact) throw httpError("Lead is flagged as Do Not Contact (DNC)", 400);
    const leadPhone = toE164(lead.phone);
    if (!leadPhone) throw httpError("Lead has no valid phone number", 400);
    if (voiceDenied(lead)) throw httpError("Voice consent has been denied", 400);

    const suppression = deps.Suppression || Suppression;
    const suppressed = await suppression.isSuppressed(orgId, {
        email: lead.email,
        phone: leadPhone,
        domain: domainFromEmail(lead.email),
    }).catch(() => false);
    if (suppressed) throw httpError("Lead is on the suppression list", 400);

    return leadPhone;
}

export async function startClickToCall(orgId, leadId, user = {}, deps = {}) {
    const adapter = deps.adapter || plivoVoiceAdapter;
    const LeadModel = deps.Lead || Lead;
    const CallModel = deps.Call || Call;
    const key = `${Number(orgId)}:${Number(leadId)}`;

    const run = async () => {
        const lead = await LeadModel.findById(leadId, orgId);
        const leadPhone = await validateLeadForClickToCall(lead, orgId, deps);

        const primaryPhone = await resolvePrimaryPhone({
            user,
            orgId,
            assignedRepId: lead.assigned_rep_id,
            requestedPhone: deps.primaryPhone || deps.repPhone || "",
            loadSettings: deps.loadSettings,
        });
        if (!primaryPhone) {
            throw httpError(
                "Set PLIVO_TRANSFER_NUMBER to your primary phone so Call can ring you first, then connect the lead.",
                400
            );
        }
        if (primaryPhone.replace(/\D/g, "").slice(-10) === leadPhone.replace(/\D/g, "").slice(-10)) {
            throw httpError("Primary phone and lead phone cannot be the same number", 400);
        }

        const existing = typeof CallModel.findLatestOpenByLead === "function"
            ? await CallModel.findLatestOpenByLead(orgId, leadId, { source: CLICK_TO_CALL_SOURCE })
            : null;
        if (existing && isClickToCallRecord(existing) && CLICK_TO_CALL_OPEN_STATUSES.has(String(existing.provider_status || "").toLowerCase())) {
            const existingSession = sessionFromCall(existing);
            const age = Date.now() - new Date(existing.created_at || 0).getTime();
            const live =
                existingSession.state === CLICK_TO_CALL_STATES.CALLING_LEAD
                || existingSession.state === CLICK_TO_CALL_STATES.CONNECTED
                || (existingSession.state === CLICK_TO_CALL_STATES.CALLING_YOU && age < 20000);
            if (live && age >= 0 && age < CLICK_TO_CALL_REUSE_WINDOW_MS) {
                return {
                    reused: true,
                    call: existing,
                    session: existingSession,
                    lead,
                    primaryPhone,
                    leadPhone,
                };
            }
        }

        const initiatedAt = new Date().toISOString();
        const created = await CallModel.create({
            organization_id: orgId,
            lead_id: lead.id,
            callback_id: deps.callbackId || null,
            idempotency_key: deps.idempotencyKey || `click_to_call_${orgId}_${lead.id}_${Date.now()}`,
            phone_number: leadPhone,
            from_number: process.env.PLIVO_PHONE_NUMBER || null,
            call_channel: "VOICE",
            call_type: "OUTBOUND",
            initiation_source: CLICK_TO_CALL_SOURCE,
            provider: "plivo",
            provider_status: "initiated",
            normalized_outcome: "INITIATED",
            cost_status: "PENDING",
            raw_metadata: persistableMeta(emptyClickToCallSession({
                leadId: lead.id,
                state: CLICK_TO_CALL_STATES.INITIATING,
                primaryPhone,
                leadPhone,
                initiatedAt,
            }), { initiatedBy: user.id || null }),
        });

        if (!created.created && created.call && isClickToCallRecord(created.call)) {
            return {
                reused: true,
                call: created.call,
                session: sessionFromCall(created.call),
                lead,
                primaryPhone,
                leadPhone,
            };
        }

        const call = created.call;
        const mpcName = `nova-ctc-${Number(orgId)}-${call.id}`;
        const result = await adapter.startClickToCallLeg({
            to: primaryPhone,
            from: process.env.PLIVO_PHONE_NUMBER || null,
            mpcName,
        });

        if (result.status !== "SUCCEEDED") {
            const failedSession = reduceClickToCallEvent(sessionFromCall(call), {
                type: "primary_failed",
                reason: result.error || "plivo_api_failure",
            });
            await saveSession(orgId, call, failedSession, { providerError: result.error || "plivo_api_failure" }, CallModel);
            throw httpError(result.error || "Could not ring the primary phone", 400);
        }

        const primaryLegUuid = result.rawResponse?.request_uuid || result.metadata?.callId || result.rawResponse?.call_uuid;
        const session = reduceClickToCallEvent(sessionFromCall({
            ...call,
            raw_metadata: persistableMeta(emptyClickToCallSession({
                callId: call.id,
                leadId: lead.id,
                state: CLICK_TO_CALL_STATES.INITIATING,
                primaryPhone,
                leadPhone,
                initiatedAt,
            })),
        }), { type: "placed", primaryLegUuid });

        const updated = await saveSession(orgId, call, { ...session, callId: call.id }, {
            mpcName,
            provider: "plivo_mpc_click_to_call",
        }, CallModel);

        if (!deps.skipEmit) {
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                user_id: user.id || null,
                channel: "VOICE",
                event_type: "CLICK_TO_CALL_STARTED",
                status: "INITIATED",
                payload: {
                    callId: call.id,
                    primaryPhone,
                    leadPhone,
                    mode: "click_to_call",
                    mpcName,
                },
            }).catch(() => {});
            await emitSession(orgId, lead.id, user.id, { ...session, callId: call.id }, "ClickToCallStarted");
        }
        if (updated && !deps.skipSync) {
            schedulePlivoCallSync(updated);
            scheduleClickToCallLeadBridge({
                orgId,
                callId: call.id,
                mpcName,
                leadPhone,
                adapter,
                CallModel,
            });
        }

        return {
            reused: false,
            call: updated || call,
            session: { ...session, callId: call.id, label: CLICK_TO_CALL_LABELS[session.state] },
            lead,
            primaryPhone,
            leadPhone,
        };
    };

    if (deps.skipLock) return run();
    const pending = inFlightByLead.get(key);
    if (pending) {
        const result = await pending;
        return { ...result, reused: true, concurrent: true };
    }
    const started = run().finally(() => inFlightByLead.delete(key));
    inFlightByLead.set(key, started);
    return started;
}

export async function getClickToCallSession(orgId, callId) {
    const call = await Call.findById(orgId, callId);
    if (!call) throw httpError("Call record not found", 404);
    return { call, session: sessionFromCall(call) };
}

export async function getLatestClickToCallForLead(orgId, leadId) {
    const call = await Call.findLatestByLead(orgId, leadId, { source: CLICK_TO_CALL_SOURCE });
    if (!call) return { call: null, session: emptyClickToCallSession({ leadId: Number(leadId) }) };
    return { call, session: sessionFromCall(call) };
}

function waitMs(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === "function") timer.unref();
    });
}

function cdrAnswered(cdr) {
    if (!cdr) return false;
    if (cdr.answer_time || cdr.AnswerTime) return true;
    const state = String(cdr.call_state || cdr.call_status || cdr.status || "").toLowerCase();
    return state.includes("answer") || state === "in-progress";
}

function cdrEnded(cdr) {
    if (!cdr) return false;
    return Boolean(cdr.end_time || cdr.hangup_cause || cdr.hangup_cause_name);
}

export function scheduleClickToCallLeadBridge({ orgId, callId, mpcName, leadPhone, adapter, CallModel } = {}) {
    if (typeof process.env.NODE_TEST_CONTEXT !== "undefined") return;
    if (!orgId || !callId || !mpcName || !leadPhone) return;
    const timer = setTimeout(() => {
        connectClickToCallLead({ orgId, callId, mpcName, leadPhone, adapter, CallModel }).catch((err) => {
            console.warn(`[ClickToCall] lead bridge failed for call ${callId}:`, err.message);
        });
    }, 1500);
    if (typeof timer.unref === "function") timer.unref();
}

async function connectClickToCallLead({
    orgId,
    callId,
    mpcName,
    leadPhone,
    adapter = plivoVoiceAdapter,
    CallModel = Call,
} = {}) {
    const deadline = Date.now() + 70000;
    let leadStarted = false;

    while (Date.now() < deadline) {
        const call = await CallModel.findById(orgId, callId).catch(() => null);
        if (!call || call.completed_at) return;
        const session = sessionFromCall(call);
        if (CLICK_TO_CALL_TERMINAL.has(session.state)) return;

        const uuid = session.primaryLegUuid || call.provider_call_uuid;
        const details = uuid && adapter.fetchCallDetails ? await adapter.fetchCallDetails(uuid).catch(() => null) : null;

        if (cdrEnded(details) && !cdrAnswered(details) && !session.primaryAnsweredAt) {
            await applyClickToCallEvent(orgId, call, {
                type: classifyPrimaryHangup({
                    CallStatus: details.hangup_cause || details.hangup_cause_name || "no-answer",
                    HangupCause: details.hangup_cause_name || details.hangup_cause,
                }),
                primaryLegUuid: uuid,
                reason: details.hangup_cause_name || details.hangup_cause || "primary_unanswered",
            }, { Call: CallModel });
            return;
        }

        if (!leadStarted && (session.primaryAnsweredAt || cdrAnswered(details))) {
            if (!session.primaryAnsweredAt) {
                await applyClickToCallEvent(orgId, call, {
                    type: "primary_answered",
                    primaryLegUuid: uuid,
                }, { Call: CallModel });
            }
            if (typeof adapter.addClickToCallLeadLeg !== "function") return;
            const added = await adapter.addClickToCallLeadLeg({
                mpcName,
                to: leadPhone,
                from: process.env.PLIVO_PHONE_NUMBER || null,
            });
            if (added.status !== "SUCCEEDED") {
                const latest = await CallModel.findById(orgId, callId).catch(() => call);
                await applyClickToCallEvent(orgId, latest || call, {
                    type: "lead_failed",
                    reason: added.error || "could_not_dial_lead",
                }, { Call: CallModel });
                return;
            }
            leadStarted = true;
            const latest = await CallModel.findById(orgId, callId).catch(() => call);
            await saveSession(orgId, latest || call, {
                ...sessionFromCall(latest || call),
                leadCalled: true,
                leadLegUuid: added.rawResponse?.request_uuid || added.metadata?.callId || null,
                state: CLICK_TO_CALL_STATES.CALLING_LEAD,
            }, { mpcName, leadDial: added.rawResponse || {} }, CallModel);
        }

        if (leadStarted && typeof adapter.listMpcParticipants === "function") {
            const members = await adapter.listMpcParticipants(mpcName).catch(() => []);
            const customer = (members || []).find((row) => /customer/i.test(String(row.role || "")) && !row.exit_time);
            if (customer && (customer.join_time || customer.call_uuid)) {
                const latest = await CallModel.findById(orgId, callId).catch(() => call);
                await applyClickToCallEvent(orgId, latest || call, {
                    type: "lead_answered",
                    leadLegUuid: customer.call_uuid || null,
                }, { Call: CallModel });
                return;
            }
        }

        await waitMs(2000);
    }

    const timedOut = await CallModel.findById(orgId, callId).catch(() => null);
    if (!timedOut || timedOut.completed_at) return;
    const timedSession = sessionFromCall(timedOut);
    if (CLICK_TO_CALL_TERMINAL.has(timedSession.state)) return;
    await applyClickToCallEvent(orgId, timedOut, {
        type: leadStarted ? "lead_no_answer" : "primary_no_answer",
        reason: leadStarted ? "lead_unanswered" : "primary_unanswered",
    }, { Call: CallModel });
}

export function resetClickToCallLocks() {
    inFlightByLead.clear();
}

export { CLICK_TO_CALL_STATES, CLICK_TO_CALL_SOURCE };

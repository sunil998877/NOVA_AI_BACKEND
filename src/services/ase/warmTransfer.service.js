import { Lead } from "../../models/lead.model.js";
import { Call } from "../../models/call.model.js";
import { AseExecution } from "../../models/ase-execution.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { query } from "../../config/db.js";
import { getIo } from "../../socket/socketServer.js";
import { asePresenceStore } from "../../socket/asePresence.store.js";
import { plivoVoiceAdapter } from "./adapters/plivoVoice.adapter.js";
import { ASE_ORG_ROOM, ASE_PRESENCE_STATES, TRANSFER_WINDOW_SECONDS } from "./asePresence.constants.js";
import { isFreeWithin, pickFreeRep, presentAseRep } from "./asePresence.service.js";
import { resolvePublicBaseUrl } from "../../utils/publicBaseUrl.js";
import { transitionLeadState } from "./leadStateMachine.js";
import { eventBus } from "./eventBus.service.js";
import { followUpEngine } from "../followup/followUpEngine.service.js";
import {
    classifyProspectSpeech,
    extractCallTranscript,
    shouldQueueHumanHandoff,
} from "./outcomeNormalizer.service.js";
import { isAlreadyHumanHandoff, queueCallbackHandoff } from "./callbackHandoff.service.js";
import {
    CALLBACK_PROMISE_SPEECH,
    FINISHED_CALL_EVENTS,
    FINISHED_CALL_STATUSES,
    HOLD_CONNECT_SPEECH,
    LIVE_CALL_STATUSES,
    REP_CONNECT_SPEECH,
    WARM_TRANSFER_ACTIONS,
    WARM_TRANSFER_REASONS,
} from "./warmTransfer.constants.js";

const pendingByConference = new Map();

export function clampTransferWindow(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n)) return TRANSFER_WINDOW_SECONDS.default;
    return Math.min(TRANSFER_WINDOW_SECONDS.max, Math.max(TRANSFER_WINDOW_SECONDS.min, Math.round(n)));
}

export function conferenceNameFor({ organizationId, leadId, callId }) {
    return `ase-${Number(organizationId) || 0}-l${Number(leadId) || 0}-c${Number(callId) || 0}`
        .replace(/[^a-zA-Z0-9-]/g, "")
        .slice(0, 64);
}

export function isFinishedCallEvent(payload = {}) {
    const status = String(payload.CallStatus || payload.callStatus || payload.status || "").toLowerCase();
    const eventName = String(payload.event || payload.event_type || "").toLowerCase();
    if (FINISHED_CALL_STATUSES.includes(status)) return true;
    if (FINISHED_CALL_EVENTS.includes(eventName)) return true;
    return Boolean(payload.completed_at || payload.EndTime || payload.end_time);
}

export function isLiveCallForTransfer(payload = {}) {
    const uuid = payload.CallUUID || payload.call_uuid || payload.request_uuid || payload.callUuid || payload.provider_call_uuid;
    if (!uuid) return false;
    if (isFinishedCallEvent(payload)) return false;
    if (payload.live === true || payload.live === "true") return true;
    const status = String(payload.CallStatus || payload.callStatus || payload.status || "").toLowerCase();
    if (LIVE_CALL_STATUSES.includes(status)) return true;
    const eventName = String(payload.event || payload.event_type || "").toLowerCase();
    if (eventName.includes("intent") || eventName.includes("disposition") || eventName === "in-progress") return true;
    return !status;
}

export function normalizeTransferPhone(value) {
    let to = String(value || "").replace(/[^\d+]/g, "");
    if (!to) return "";
    if (to.startsWith("0") && to.length === 11) to = "+91" + to.slice(1);
    else if (!to.startsWith("+") && to.length === 10 && /^[6-9]/.test(to)) to = "+91" + to;
    else if (!to.startsWith("+") && to.length === 12 && to.startsWith("91")) to = "+" + to;
    const digits = to.replace(/[^\d]/g, "");
    return digits.length >= 10 && digits.length <= 15 ? to : "";
}

export function resolveRepTransferPhone(rep = {}, settings = {}, envNumber = process.env.PLIVO_TRANSFER_NUMBER) {
    const id = String(rep.userId || rep.id || "");
    const overlays = settings?.routing?.reps || settings?.transfer?.reps || {};
    const extra = overlays[id] || overlays[Number(id)] || {};
    return normalizeTransferPhone(
        extra.phone || extra.transferNumber || extra.sip || rep.phone || settings?.transfer?.defaultNumber || envNumber
    );
}

export function evaluateWarmTransfer({
    liveCall = false,
    callUuid = null,
    freeRep = null,
    transferPhone = "",
    windowSeconds = TRANSFER_WINDOW_SECONDS.default,
    alreadyHandedOff = false,
} = {}) {
    const window = clampTransferWindow(windowSeconds);
    if (alreadyHandedOff) {
        return { action: WARM_TRANSFER_ACTIONS.CALLBACK, reason: WARM_TRANSFER_REASONS.ALREADY_HANDED_OFF, windowSeconds: window };
    }
    if (!liveCall) {
        return { action: WARM_TRANSFER_ACTIONS.CALLBACK, reason: WARM_TRANSFER_REASONS.CALL_NOT_LIVE, windowSeconds: window };
    }
    if (!callUuid) {
        return { action: WARM_TRANSFER_ACTIONS.CALLBACK, reason: WARM_TRANSFER_REASONS.NO_CALL_UUID, windowSeconds: window };
    }
    if (!freeRep) {
        return { action: WARM_TRANSFER_ACTIONS.CALLBACK, reason: WARM_TRANSFER_REASONS.NO_FREE_REP, windowSeconds: window };
    }
    const presented = presentAseRep(freeRep);
    if (!isFreeWithin(presented, window)) {
        return { action: WARM_TRANSFER_ACTIONS.CALLBACK, reason: WARM_TRANSFER_REASONS.REP_OUTSIDE_WINDOW, windowSeconds: window };
    }
    if (!normalizeTransferPhone(transferPhone || presented.phone)) {
        return { action: WARM_TRANSFER_ACTIONS.CALLBACK, reason: WARM_TRANSFER_REASONS.REP_NO_TRANSFER_NUMBER, windowSeconds: window, rep: presented };
    }
    return {
        action: WARM_TRANSFER_ACTIONS.TRANSFER,
        reason: null,
        windowSeconds: window,
        rep: presented,
        transferPhone: normalizeTransferPhone(transferPhone || presented.phone),
    };
}

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

async function loadOrgSettings(orgId) {
    try {
        const rows = await query("SELECT settings FROM organizations WHERE id = ? LIMIT 1", [Number(orgId)]);
        return parseJson(rows?.[0]?.settings);
    } catch {
        return {};
    }
}

function emitTransfer(orgId, eventName, payload) {
    const io = getIo();
    if (!io) return;
    io.to(ASE_ORG_ROOM(orgId)).emit(eventName, payload);
}

export function rememberTransfer(record) {
    if (record?.conferenceName) pendingByConference.set(record.conferenceName, record);
    return record;
}

export function getPendingTransfer(conferenceName) {
    return pendingByConference.get(String(conferenceName || "")) || null;
}

export function forgetTransfer(conferenceName) {
    pendingByConference.delete(String(conferenceName || ""));
}

export function resetWarmTransfers() {
    pendingByConference.clear();
}

async function webhookQuery(extra = {}) {
    const params = new URLSearchParams();
    const token = process.env.VOICE_WEBHOOK_SECRET || "";
    if (token) params.set("token", token);
    for (const [key, value] of Object.entries(extra)) {
        if (value != null && value !== "") params.set(key, String(value));
    }
    const qs = params.toString();
    const base = await resolvePublicBaseUrl();
    return { base, qs: qs ? `?${qs}` : "" };
}

export async function attemptWarmTransfer(lead, rawData = {}, deps = {}) {
    const adapter = deps.adapter || plivoVoiceAdapter;
    const orgId = Number(lead?.organization_id || rawData.organization_id || 1);
    if (!lead?.id) {
        return { action: WARM_TRANSFER_ACTIONS.CALLBACK, reason: "NO_LEAD", applied: false };
    }
    if (isAlreadyHumanHandoff(lead)) {
        return { action: WARM_TRANSFER_ACTIONS.CALLBACK, reason: WARM_TRANSFER_REASONS.ALREADY_HANDED_OFF, applied: false };
    }

    const callUuid = rawData.CallUUID || rawData.call_uuid || rawData.provider_call_uuid || rawData.callUuid || null;
    const liveCall = rawData.liveCall != null ? Boolean(rawData.liveCall) : isLiveCallForTransfer(rawData);
    const settings = deps.settings || await loadOrgSettings(orgId);
    const windowSeconds = clampTransferWindow(settings?.transfer?.windowSeconds);
    const live = deps.reps || asePresenceStore.listByOrg(orgId);
    const freeRep = deps.freeRep || pickFreeRep(live, { windowSeconds });
    const transferPhone = resolveRepTransferPhone(freeRep || {}, settings, process.env.PLIVO_TRANSFER_NUMBER);
    const verdict = evaluateWarmTransfer({
        liveCall,
        callUuid,
        freeRep,
        transferPhone,
        windowSeconds,
    });

    if (verdict.action !== WARM_TRANSFER_ACTIONS.TRANSFER) {
        if (liveCall && callUuid && adapter.speakAndHangup) {
            await adapter.speakAndHangup(callUuid, CALLBACK_PROMISE_SPEECH).catch(() => null);
        }
        return { ...verdict, applied: false, speakPromise: Boolean(liveCall && callUuid) };
    }

    const callId = Number(rawData.callId || rawData.call_id || 0) || null;
    const conferenceName = conferenceNameFor({ organizationId: orgId, leadId: lead.id, callId: callId || Date.now() });
    const { base, qs } = await webhookQuery({
        room: conferenceName,
        orgId,
        leadId: lead.id,
        callId: callId || "",
        repId: verdict.rep.userId,
    });
    const bridgeUrl = `${base}/api/engine/voice/plivo/transfer/bridge${qs}`;
    const joinUrl = `${base}/api/engine/voice/plivo/transfer/join${qs}`;
    const hangupUrl = `${base}/api/engine/voice/plivo/transfer/status${qs}`;

    const bridge = await adapter.transferLiveCall(callUuid, bridgeUrl);
    if (bridge?.status === "FAILED") {
        if (adapter.speakAndHangup) {
            await adapter.speakAndHangup(callUuid, CALLBACK_PROMISE_SPEECH).catch(() => null);
        }
        return {
            action: WARM_TRANSFER_ACTIONS.CALLBACK,
            reason: WARM_TRANSFER_REASONS.PROVIDER_FAILED,
            applied: false,
            speakPromise: true,
            error: bridge.error,
        };
    }

    const dial = await adapter.dialIntoConference(verdict.transferPhone, {
        answerUrl: joinUrl,
        hangupUrl,
        from: process.env.PLIVO_PHONE_NUMBER,
    });
    if (dial?.status === "FAILED") {
        if (adapter.speakAndHangup) {
            await adapter.speakAndHangup(callUuid, CALLBACK_PROMISE_SPEECH).catch(() => null);
        }
        return {
            action: WARM_TRANSFER_ACTIONS.CALLBACK,
            reason: WARM_TRANSFER_REASONS.PROVIDER_FAILED,
            applied: false,
            speakPromise: true,
            error: dial.error,
        };
    }

    const transition = transitionLeadState(lead.status, "WARM_TRANSFER", { reason: "live_interest" });
    await followUpEngine.handleMeetingBooked(lead.id, orgId).catch(() => {});
    await AseExecution.cancelOpenForLead(orgId, lead.id, "Warm transfer — no second bot call").catch(() => 0);

    const updated = await Lead.updateById(
        lead.id,
        {
            status: transition.nextState,
            assigned_rep_id: Number(verdict.rep.userId) || lead.assigned_rep_id,
            health: "AMBER",
            next_action: "REP_CALLBACK",
            next_action_time: null,
        },
        orgId
    );

    if (callId) {
        const existing = await Call.findById(orgId, callId).catch(() => null);
        const meta = parseJson(existing?.raw_metadata);
        await Call.updateById(orgId, callId, {
            raw_metadata: {
                ...meta,
                warmTransfer: {
                    status: "PENDING",
                    conferenceName,
                    repUserId: verdict.rep.userId,
                    transferPhone: verdict.transferPhone,
                    windowSeconds,
                },
            },
        }).catch(() => null);
    }

    asePresenceStore.setState(verdict.rep.userId, {
        state: ASE_PRESENCE_STATES.ON_CALL,
        freeWithinSeconds: 0,
    });

    rememberTransfer({
        conferenceName,
        organizationId: orgId,
        leadId: lead.id,
        callId,
        callUuid,
        repUserId: String(verdict.rep.userId),
        transferPhone: verdict.transferPhone,
        startedAt: new Date().toISOString(),
    });

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        channel: "VOICE",
        event_type: "WARM_TRANSFER",
        status: "PENDING",
        payload: {
            conferenceName,
            assigned_rep_id: verdict.rep.userId,
            windowSeconds,
            callUuid,
        },
        idempotency_key: `warm_transfer_${orgId}_${lead.id}_${conferenceName}`,
    }).catch(() => {});

    await eventBus.publish("WarmTransferStarted", {
        organization_id: orgId,
        lead_id: lead.id,
        channel: "VOICE",
        conference: conferenceName,
        assigned_rep_id: verdict.rep.userId,
        call_id: callId,
    });

    emitTransfer(orgId, "ase:transfer:incoming", {
        leadId: lead.id,
        leadName: lead.name,
        company: lead.company,
        conferenceName,
        assignedRepId: verdict.rep.userId,
        callId,
    });

    return {
        action: WARM_TRANSFER_ACTIONS.TRANSFER,
        reason: null,
        applied: true,
        conferenceName,
        lead: updated || lead,
        rep: verdict.rep,
        nextState: updated?.status || "WARM_TRANSFER",
        simulated: Boolean(bridge?.rawResponse?.simulated || dial?.rawResponse?.simulated),
    };
}

export async function completeWarmTransfer(conferenceName, extras = {}) {
    const pending = getPendingTransfer(conferenceName) || extras.pending;
    if (!pending) return { completed: false, reason: "UNKNOWN_CONFERENCE" };
    const orgId = Number(pending.organizationId);
    const lead = await Lead.findById(pending.leadId, orgId);
    if (!lead) return { completed: false, reason: "LEAD_NOT_FOUND" };

    const transition = transitionLeadState(lead.status, "HANDOFF_COMPLETED", { reason: "rep_joined_conference" });
    const updated = await Lead.updateById(
        lead.id,
        {
            status: transition.nextState,
            assigned_rep_id: Number(pending.repUserId) || lead.assigned_rep_id,
            next_action: null,
            next_action_time: null,
            health: "AMBER",
        },
        orgId
    );

    if (pending.callId) {
        const existing = await Call.findById(orgId, pending.callId).catch(() => null);
        const meta = parseJson(existing?.raw_metadata);
        await Call.updateById(orgId, pending.callId, {
            raw_metadata: {
                ...meta,
                warmTransfer: { ...(meta.warmTransfer || {}), status: "CONNECTED" },
            },
        }).catch(() => null);
    }

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        channel: "VOICE",
        event_type: "HANDOFF_COMPLETED",
        status: "HANDED_OFF",
        payload: { conferenceName, assigned_rep_id: pending.repUserId },
        idempotency_key: `handoff_completed_${orgId}_${lead.id}_${conferenceName}`,
    }).catch(() => {});

    await eventBus.publish("WarmTransferCompleted", {
        organization_id: orgId,
        lead_id: lead.id,
        channel: "VOICE",
        conference: conferenceName,
        assigned_rep_id: pending.repUserId,
    });

    forgetTransfer(conferenceName);
    return { completed: true, lead: updated || lead, nextState: updated?.status || "HANDED_OFF" };
}

export async function failWarmTransfer(conferenceName, extras = {}) {
    const pending = getPendingTransfer(conferenceName) || extras.pending;
    if (!pending) return { failed: false, reason: "UNKNOWN_CONFERENCE" };
    const orgId = Number(pending.organizationId);
    const lead = await Lead.findById(pending.leadId, orgId);
    if (!lead) return { failed: false, reason: "LEAD_NOT_FOUND" };

    const queued = await queueCallbackHandoff(lead, {
        channel: "VOICE",
        callId: pending.callId,
        organization_id: orgId,
        outcome: extras.outcome,
    }, {
        failedTransfer: true,
        eventName: "TRANSFER_FAILED",
        assignedRepId: pending.repUserId,
        notes: `Live transfer missed (${extras.reason || WARM_TRANSFER_REASONS.TRANSFER_FAILED}). Bot promised a human. 30-min SLA.`,
        reason: extras.reason || WARM_TRANSFER_REASONS.TRANSFER_FAILED,
    });

    emitTransfer(orgId, "ase:transfer:missed", {
        leadId: lead.id,
        leadName: lead.name,
        conferenceName,
        assignedRepId: pending.repUserId,
        reason: extras.reason || WARM_TRANSFER_REASONS.TRANSFER_FAILED,
    });

    forgetTransfer(conferenceName);
    return { failed: true, ...queued };
}

export async function handleLiveVoiceInterest(payload = {}, deps = {}) {
    const transcript = extractCallTranscript(payload);
    const classified = classifyProspectSpeech(transcript);
    const outcome = classified.outcome;
    if (!shouldQueueHumanHandoff(outcome, { ...payload, isAnswered: true, channel: "VOICE" })) {
        return { handled: false, reason: "NOT_HANDOFF_INTENT" };
    }
    if (!isLiveCallForTransfer(payload)) {
        return { handled: false, reason: WARM_TRANSFER_REASONS.CALL_NOT_LIVE };
    }

    const orgId = Number(payload.orgId || payload.organization_id || 0);
    const leadId = Number(payload.leadId || payload.lead_id || 0);
    if (!orgId || !leadId) return { handled: false, reason: "MISSING_LEAD" };
    const lead = await Lead.findById(leadId, orgId);
    if (!lead) return { handled: false, reason: "LEAD_NOT_FOUND" };

    const transfer = await attemptWarmTransfer(lead, {
        ...payload,
        channel: "VOICE",
        outcome,
        isAnswered: true,
        liveCall: true,
    }, deps);

    if (transfer.action === WARM_TRANSFER_ACTIONS.TRANSFER && transfer.applied) {
        return { handled: true, ...transfer };
    }

    const queued = await queueCallbackHandoff(lead, {
        ...payload,
        channel: "VOICE",
        outcome,
        callId: payload.callId || payload.call_id,
    }, {
                notes: `Missed live transfer (${transfer.reason}). Bot promised a human. 30-min SLA.`,
        reason: transfer.reason,
        outcome,
        missedTransfer: true,
    });
    return { handled: true, action: WARM_TRANSFER_ACTIONS.CALLBACK, speakPromise: transfer.speakPromise, ...queued, reason: transfer.reason };
}

export function transferBridgeXml(conferenceName) {
    return plivoVoiceAdapter.generateConferenceXml({
        conferenceName,
        message: HOLD_CONNECT_SPEECH,
        endOnExit: false,
    });
}

export function transferJoinXml(conferenceName) {
    return plivoVoiceAdapter.generateConferenceXml({
        conferenceName,
        message: REP_CONNECT_SPEECH,
        endOnExit: true,
    });
}

import { Callback } from "../../models/callback.model.js";
import { Call } from "../../models/call.model.js";
import { Lead } from "../../models/lead.model.js";
import { TelephonyWebhookEvent } from "../../models/telephony-webhook-event.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { plivoVoiceAdapter } from "./adapters/plivoVoice.adapter.js";
import { extractCallTranscript } from "./outcomeNormalizer.service.js";
import { schedulePlivoCallSync } from "./plivoCallPoll.service.js";

const REUSE_WINDOW_MS = 2 * 60 * 1000;
const OPEN_STATUSES = new Set(["initiated", "ringing", "in-progress", "queued", "unknown"]);

const OUTCOME_TO_DISPOSITION = {
    INTERESTED: "connected_interested",
    QUALIFIED: "qualified",
    CALLBACK: "callback_requested",
    NOT_INTERESTED: "connected_not_interested",
    DNC: "connected_not_interested",
    NO_ANSWER: "no_answer",
    BUSY: "busy",
    RING_TIMEOUT: "no_answer",
    FAILED: "no_answer",
};

export function toE164(phone) {
    const raw = String(phone || "").trim();
    if (!raw) return "";
    let digits = raw.replace(/[^\d+]/g, "");
    if (digits.startsWith("0") && digits.length === 11) digits = "+91" + digits.slice(1);
    else if (!digits.startsWith("+") && digits.length === 10 && /^[6-9]/.test(digits)) digits = "+91" + digits;
    else if (!digits.startsWith("+") && digits.length === 12 && digits.startsWith("91")) digits = "+" + digits;
    return digits;
}

export function toTelHref(phone) {
    const e164 = toE164(phone);
    return e164 ? `tel:${e164}` : "";
}

export function suggestCallbackDisposition(normalizedOutcome, providerStatus) {
    const status = String(providerStatus || "").toLowerCase();
    if (status.includes("busy")) return "busy";
    if (status.includes("no-answer") || status.includes("timeout")) return "no_answer";
    if (status.includes("failed") || status.includes("rejected")) return "invalid_number";
    const mapped = OUTCOME_TO_DISPOSITION[String(normalizedOutcome || "").toUpperCase()];
    return mapped || "connected_interested";
}

export function buildConversationNotes({ transcript, durationSec, outcome, recordingUrl } = {}) {
    const lines = [];
    const duration = Number(durationSec) || 0;
    if (duration > 0) lines.push(`Recorded call · ${duration}s`);
    if (outcome) lines.push(`Outcome: ${outcome}`);
    if (recordingUrl) lines.push(`Recording: ${recordingUrl}`);
    const speech = String(transcript || "").trim();
    if (speech) {
        lines.push("Conversation:");
        lines.push(speech);
    }
    return lines.join("\n").trim();
}

function parseMeta(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
}

function recordingUrlFrom(raw = {}) {
    const buckets = [raw, raw.variables, raw.data, raw.result, raw.payload, raw.call].filter((row) => row && typeof row === "object");
    for (const obj of buckets) {
        for (const key of ["recording_url", "RecordingUrl", "record_url", "recordingUrl", "RecordUrl"]) {
            if (typeof obj[key] === "string" && obj[key].trim()) return obj[key].trim();
        }
    }
    return "";
}

export function conversationFromCall(call, webhookEvents = []) {
    const meta = parseMeta(call?.raw_metadata);
    let transcript = extractCallTranscript(meta);
    let recordingUrl = recordingUrlFrom(meta);
    for (const event of webhookEvents) {
        const payload = event?.payload || {};
        if (!transcript) transcript = extractCallTranscript(payload);
        if (!recordingUrl) recordingUrl = recordingUrlFrom(payload);
    }
    const notes = buildConversationNotes({
        transcript,
        durationSec: call?.duration_sec || call?.duration_seconds,
        outcome: call?.normalized_outcome,
        recordingUrl,
    });
    return {
        transcript,
        recordingUrl,
        notes,
        suggestedOutcome: suggestCallbackDisposition(call?.normalized_outcome, call?.provider_status),
        durationSec: Number(call?.duration_sec || call?.duration_seconds || 0),
        status: call?.provider_status || "initiated",
        isAnswered: Boolean(call?.is_answered),
        completed: Boolean(call?.completed_at),
    };
}

export async function startCallbackCall(orgId, callbackId, user = {}, deps = {}) {
    const adapter = deps.adapter || plivoVoiceAdapter;
    const callback = await Callback.findById(orgId, callbackId);
    if (!callback) {
        throw Object.assign(new Error("Callback not found"), { status: 404 });
    }
    if (String(callback.status || "").toUpperCase() === "COMPLETED") {
        throw Object.assign(new Error("This callback is already completed"), { status: 400 });
    }

    const lead = await Lead.findById(callback.lead_id, orgId);
    if (!lead) {
        throw Object.assign(new Error("Lead not found"), { status: 404 });
    }
    if (lead.do_not_contact) {
        throw Object.assign(new Error("Lead is suppressed (Do Not Contact)"), { status: 400 });
    }

    const phone = lead.phone || callback.lead_phone;
    const telHref = toTelHref(phone);
    if (!phone || !toE164(phone)) {
        throw Object.assign(new Error("Lead has no valid phone number"), { status: 400 });
    }

    const existing = await Call.findLatestByCallbackId(orgId, callback.id);
    if (existing && OPEN_STATUSES.has(String(existing.provider_status || "").toLowerCase())) {
        const age = Date.now() - new Date(existing.created_at || 0).getTime();
        if (age >= 0 && age < REUSE_WINDOW_MS) {
            return {
                reused: true,
                callback,
                lead,
                call: existing,
                telHref,
                to: toE164(phone),
                from: existing.from_number || process.env.PLIVO_PHONE_NUMBER || null,
            };
        }
    }

    const created = await Call.create({
        organization_id: orgId,
        lead_id: lead.id,
        callback_id: callback.id,
        idempotency_key: `callback_call_${orgId}_${callback.id}_${Date.now()}`,
        phone_number: phone,
        from_number: process.env.PLIVO_PHONE_NUMBER || null,
        call_channel: "VOICE",
        call_type: "OUTBOUND",
        initiation_source: "CALLBACK_QUEUE",
        provider: "plivo",
        provider_status: "initiated",
        normalized_outcome: "INITIATED",
        cost_status: "PENDING",
    });

    const result = await adapter.execute(lead, "CALL", {
        from: process.env.PLIVO_PHONE_NUMBER || null,
        callId: created.call.id,
        record: true,
        requireRealProvider: Boolean(deps.requireRealProvider),
        prompt: `This is a human callback for ${lead.name || "the prospect"}. Connect the sales conversation.`,
    });

    if (result.status !== "SUCCEEDED") {
        await Call.updateById(orgId, created.call.id, {
            provider_status: "request_failed",
            normalized_outcome: "FAILED",
            failure_reason: result.error,
        });
        throw Object.assign(new Error(result.error || "Could not place the callback call"), { status: 400 });
    }

    const providerUuid = result.metadata?.providerCallId || result.metadata?.callId;
    const updatedCall = await Call.updateById(orgId, created.call.id, {
        provider_call_uuid: providerUuid,
        provider_status: "initiated",
        raw_metadata: {
            source: "callback_queue",
            telHref,
            record: true,
            provider: result.metadata?.provider || "plivo",
        },
    });

    await Callback.updateById(orgId, callback.id, {
        call_id: created.call.id,
        status: "IN_PROGRESS",
        assigned_rep_id: callback.assigned_rep_id || user.id || null,
    });

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        user_id: user.id || null,
        channel: "VOICE",
        event_type: "CALLBACK_CALL_STARTED",
        status: "INITIATED",
        payload: {
            callbackId: callback.id,
            callId: created.call.id,
            to: toE164(phone),
            telHref,
        },
    }).catch(() => {});

    schedulePlivoCallSync(updatedCall || created.call);

    return {
        reused: false,
        callback,
        lead,
        call: updatedCall || created.call,
        telHref,
        to: toE164(phone),
        from: process.env.PLIVO_PHONE_NUMBER || null,
    };
}

export async function getCallbackCallStatus(orgId, callbackId) {
    const callback = await Callback.findById(orgId, callbackId);
    if (!callback) {
        throw Object.assign(new Error("Callback not found"), { status: 404 });
    }

    let call = await Call.findLatestByCallbackId(orgId, callback.id);
    if (!call && callback.call_id) {
        call = await Call.findById(orgId, callback.call_id);
    }

    const events = call?.provider_call_uuid
        ? await TelephonyWebhookEvent.listByCallUuid(call.provider_call_uuid).catch(() => [])
        : [];
    const conversation = conversationFromCall(call, events);
    return {
        callback,
        call,
        telHref: toTelHref(callback.lead_phone || call?.phone_number),
        ...conversation,
    };
}

export async function notesForComplete(orgId, callbackId, typedNotes) {
    const typed = String(typedNotes || "").trim();
    if (typed) return typed;
    const status = await getCallbackCallStatus(orgId, callbackId);
    return status.notes || "";
}

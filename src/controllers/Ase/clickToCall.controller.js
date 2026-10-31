import { asyncHandler } from "../../utils/asyncHandler.js";
import { plivoVoiceAdapter } from "../../services/ase/adapters/plivoVoice.adapter.js";
import {
    applyClickToCallEvent,
    applyClickToCallProviderStatus,
    classifyDialStatus,
    clickToCallAnswerXml,
    getClickToCallSession,
    getLatestClickToCallForLead,
    sessionFromCall,
    startClickToCall,
    toE164,
} from "../../services/ase/clickToCall.service.js";
import { CLICK_TO_CALL_LABELS } from "../../services/ase/clickToCall.constants.js";
import { Call } from "../../models/call.model.js";
import { TelephonyWebhookEvent } from "../../models/telephony-webhook-event.model.js";
import { resolvePublicBaseUrl } from "../../utils/publicBaseUrl.js";

function httpError(err, res) {
    return res.status(err.status || 500).json({ error: err.message });
}

function publicSession(result) {
    const session = result.session || {};
    const state = session.state || "idle";
    return {
        callId: result.call?.id || session.callId || null,
        leadId: result.call?.lead_id || session.leadId || null,
        state,
        label: session.label || CLICK_TO_CALL_LABELS[state] || "Call",
        primaryPhone: session.primaryPhone || null,
        leadPhone: session.leadPhone || result.leadPhone || null,
        initiatedAt: session.initiatedAt || null,
        reused: Boolean(result.reused),
        concurrent: Boolean(result.concurrent),
        connectedDurationSec: session.connectedDurationSec || 0,
        failureReason: session.failureReason || null,
        mode: "click_to_call",
    };
}

export const startLeadClickToCall = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const leadId = Number(req.params.leadId || req.params.id || req.body?.leadId);
    if (!leadId) {
        return res.status(400).json({ error: "leadId is required" });
    }
    try {
        const result = await startClickToCall(orgId, leadId, req.user, {
            primaryPhone: req.body?.primaryPhone || req.body?.repPhone || "",
            idempotencyKey: req.body?.idempotencyKey || null,
        });
        return res.status(200).json({
            success: true,
            data: publicSession(result),
        });
    } catch (err) {
        return httpError(err, res);
    }
});

export const getLeadClickToCall = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const leadId = Number(req.params.leadId || req.params.id);
    try {
        const result = await getLatestClickToCallForLead(orgId, leadId);
        return res.status(200).json({
            success: true,
            data: publicSession(result),
        });
    } catch (err) {
        return httpError(err, res);
    }
});

export const getClickToCallById = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    try {
        const result = await getClickToCallSession(orgId, req.params.callId || req.params.id);
        return res.status(200).json({
            success: true,
            data: publicSession(result),
        });
    } catch (err) {
        return httpError(err, res);
    }
});

function xmlResponse(res, xml) {
    res.set("Content-Type", "application/xml");
    return res.status(200).send(xml);
}

export const handleClickToCallAnswer = asyncHandler(async (req, res) => {
    const query = req.query || {};
    const payload = { ...(req.body || {}), ...query };
    const callId = query.callId || payload.callId;
    const orgId = Number(query.orgId || payload.orgId || 1);
    const callUuid = payload.CallUUID || payload.CallId;

    let call = null;
    if (callId) {
        call = await Call.findById(orgId, callId).catch(() => null)
            || await Call.findByIdAnyOrg(callId).catch(() => null);
    }

    const session = call ? sessionFromCall(call) : null;
    const leadNumber = session?.leadPhone || call?.phone_number || query.lead || payload.lead || payload.leadPhone;
    const callerId = process.env.PLIVO_PHONE_NUMBER || query.from || payload.from;
    const resolvedOrgId = Number(call?.organization_id || orgId || 1);

    if (call) {
        await applyClickToCallEvent(resolvedOrgId, call, {
            type: "primary_answered",
            primaryLegUuid: callUuid,
        }).catch(() => null);
    }

    if (callUuid) {
        await TelephonyWebhookEvent.recordEvent({
            organization_id: resolvedOrgId,
            provider: "plivo",
            provider_call_uuid: callUuid,
            event_type: "CLICK_TO_CALL_ANSWER",
            payload,
        }).catch(() => {});
    }

    if (!toE164(leadNumber)) {
        return xmlResponse(res, plivoVoiceAdapter.generateCallbackPromiseXml("Could not connect to the prospect."));
    }

    const params = new URLSearchParams();
    params.set("callId", String(call?.id || callId || ""));
    params.set("orgId", String(resolvedOrgId));
    if (process.env.VOICE_WEBHOOK_SECRET) params.set("token", process.env.VOICE_WEBHOOK_SECRET);
    const proto = String(req.get?.("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
    const host = String(req.get?.("x-forwarded-host") || req.get?.("host") || "").split(",")[0].trim();
    const requestBase = host && !/localhost|127\.0\.0\.1/i.test(host) ? `${proto}://${host}`.replace(/\/$/, "") : "";
    const base = /^https:\/\//i.test(requestBase) ? requestBase : await resolvePublicBaseUrl();
    const dialCallbackUrl = `${base}/api/engine/voice/plivo/click-to-call/dial?${params.toString()}`;

    return xmlResponse(res, clickToCallAnswerXml({
        leadNumber,
        callerId,
        timeout: query.timeout || payload.timeout,
        dialCallbackUrl,
        leadName: call?.lead_name || payload.leadName,
    }));
});

export const handleClickToCallStatus = asyncHandler(async (req, res) => {
    const payload = { ...(req.query || {}), ...(req.body || {}) };
    const result = await applyClickToCallProviderStatus(payload);
    return res.status(200).json({ status: "received", ...(result?.session ? { state: result.session.state } : {}) });
});

export const handleClickToCallDial = asyncHandler(async (req, res) => {
    const payload = { ...(req.query || {}), ...(req.body || {}) };
    const callId = payload.callId;
    const orgId = Number(payload.orgId || 1);
    const classified = classifyDialStatus(payload);

    if (callId && classified) {
        let call = await Call.findById(orgId, callId).catch(() => null);
        if (call) {
            const first = await applyClickToCallEvent(orgId, call, {
                type: classified.type,
                leadLegUuid: classified.leadLegUuid,
                durationSec: classified.durationSec,
            });
            if (classified.followedBy === "disconnected" && first?.call) {
                await applyClickToCallEvent(orgId, first.call, {
                    type: "disconnected",
                    durationSec: Number(payload.DialDuration || payload.Duration || classified.durationSec || 0),
                });
            }
        }
    } else {
        await applyClickToCallProviderStatus(payload);
    }

    return res.status(200).json({ status: "received" });
});

import { plivoVoiceAdapter } from "../../services/ase/adapters/plivoVoice.adapter.js";
import { tryPlaybookVoice } from "../../services/ase/salesPlaybook.service.js";
import { OrchestratorService } from "../../services/ase/orchestrator.service.js";
import { Lead } from "../../models/lead.model.js";
import { Call } from "../../models/call.model.js";
import { TelephonyWebhookEvent } from "../../models/telephony-webhook-event.model.js";
import { aseScheduler } from "../../services/ase/scheduler.service.js";
import { eventBus } from "../../services/ase/eventBus.service.js";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { extractCallTranscript, ASE_OUTCOMES } from "../../services/ase/outcomeNormalizer.service.js";
import { validateDispatchEligibility } from "../../services/ase/complianceGate.service.js";
import { applyPlivoCallPayload } from "../../services/ase/voiceOutcomeApply.service.js";
import { handleLiveVoiceInterest, isFinishedCallEvent } from "../../services/ase/warmTransfer.service.js";
import { schedulePlivoCallSync } from "../../services/ase/plivoCallPoll.service.js";
import { enqueuePendingApproval } from "../../services/ase/approvalQueue.service.js";
import { executionFlagsForMode, getOperatingMode } from "../../services/ase/operatingMode.service.js";
import { OPERATING_MODES } from "../../services/ase/operatingMode.constants.js";

const normalizePhone = (num) => {
    if (!num) return "";
    return String(num).replace(/\D/g, "").slice(-10);
};

export const handlePlivoAnswer = asyncHandler(async (req, res) => {
    const payload = { ...(req.query || {}), ...(req.body || {}) };
    const callUuid = payload.CallUUID || payload.CallId || payload.request_uuid;
    let orgId = Number(payload.orgId || payload.organization_id || 0);
    const leadId = payload.leadId ? Number(payload.leadId) : null;
    const leadName = payload.leadName || "there";
    const customMessage = payload.message;
    if (callUuid) {
        const existingCall = await Call.findByProviderUuidAnyOrg(callUuid);
        if (existingCall?.organization_id) orgId = Number(existingCall.organization_id);
    }
    const lead = leadId && orgId ? await Lead.findById(leadId, orgId).catch(() => null) : null;

    if (callUuid) {
        await TelephonyWebhookEvent.recordEvent({
            organization_id: orgId,
            provider: "plivo",
            provider_call_uuid: callUuid,
            event_type: "ANSWER",
            payload,
        });

        const existingCall = await Call.findByProviderUuid(orgId, callUuid);
        if (existingCall) {
            await Call.updateById(orgId, existingCall.id, {
                is_answered: 1,
                answered_at: new Date(),
                provider_status: "in-progress",
                normalized_outcome: "IN_PROGRESS",
            });

            await eventBus.publish("CallAnswered", {
                organization_id: orgId,
                lead_id: existingCall.lead_id,
                channel: "VOICE",
                call_id: existingCall.id,
                provider_call_uuid: callUuid,
                timestamp: new Date().toISOString(),
            });
        }
    }

    const playbookVoice = lead ? await tryPlaybookVoice(lead).catch(() => null) : null;
    const xml = plivoVoiceAdapter.generateAnswerXml({
        message: customMessage || playbookVoice?.openingLine,
        leadName: lead?.name || leadName,
        lead,
    });

    res.set("Content-Type", "application/xml");
    return res.status(200).send(xml);
});

export const handlePlivoStatus = asyncHandler(async (req, res) => {
    const payload = { ...(req.query || {}), ...(req.body || {}) };
    const result = await applyPlivoCallPayload(payload);
    return res.status(200).json(result);
});

export const dispatchVoiceCall = asyncHandler(async (req, res) => {
    const { leadId, prompt, from } = req.body || {};
    const orgId = Number(req.user?.organization_id || 1);

    if (!leadId) {
        return res.status(400).json({ error: "leadId is required" });
    }

    const lead = await Lead.findById(leadId, orgId);
    if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
    }

    if (!lead.phone) {
        return res.status(400).json({ error: "Lead has no phone number configured" });
    }
    const cleanedDigits = String(lead.phone || "").replace(/[^\d]/g, "");
    if (cleanedDigits.length < 10 || cleanedDigits.length > 15) {
        return res.status(400).json({ error: "Lead phone number is unverified or invalid" });
    }

    const eligibility = await validateDispatchEligibility(lead, "CALL", {
        bypassCallingHours: true,
        bypassCooldown: true,
        isEngagementTrigger: true,
    });
    if (!eligibility.eligible) {
        return res.status(400).json({ error: eligibility.reason || "Call is not eligible" });
    }

    const idempotencyKey = `manual_dispatch_${orgId}_${lead.id}_${Date.now()}`;
    const callResult = await Call.create({
        organization_id: orgId,
        lead_id: lead.id,
        idempotency_key: idempotencyKey,
        phone_number: lead.phone,
        from_number: from || process.env.PLIVO_PHONE_NUMBER || null,
        call_channel: "VOICE",
        call_type: "OUTBOUND",
        initiation_source: "MANUAL",
        provider: "plivo",
        provider_status: "initiated",
        normalized_outcome: "INITIATED",
        cost_status: "PENDING",
    });

    const result = await plivoVoiceAdapter.execute(lead, "CALL", {
        prompt,
        from,
        callId: callResult.call.id,
        requireRealProvider: Boolean(req.body.requireRealProvider),
    });

    if (result.status === "SUCCEEDED") {
        const updatedCall = await Call.updateById(orgId, callResult.call.id, {
            provider_call_uuid: result.metadata?.providerCallId,
            provider_status: "initiated",
            normalized_outcome: "INITIATED",
        });
        schedulePlivoCallSync(updatedCall || { ...callResult.call, provider_call_uuid: result.metadata?.providerCallId });
        return res.status(200).json({ data: { ...result, callId: callResult.call.id } });
    } else {
        await Call.updateById(orgId, callResult.call.id, {
            provider_status: "request_failed",
            normalized_outcome: "FAILED",
            failure_reason: result.error,
        });
        return res.status(400).json({ data: { ...result, callId: callResult.call.id } });
    }
});

export const getVoiceConfig = asyncHandler(async (req, res) => {
    const isConfigured = plivoVoiceAdapter.isConfigured();
    const missing = plivoVoiceAdapter.getMissingConfiguration();

    return res.status(200).json({
        data: {
            provider: "plivo",
            configured: isConfigured,
            missingFields: missing,
            hasFromNumber: Boolean(process.env.PLIVO_PHONE_NUMBER),
        },
    });
});

export const simulateVoiceOutcome = asyncHandler(async (req, res) => {
    const { leadId, outcome, transcript, duration = 30, isAnswered = true } = req.body || {};
    const orgId = Number(req.user?.organization_id || 1);

    if (!leadId) {
        return res.status(400).json({ error: "leadId is required" });
    }

    const lead = await Lead.findById(leadId, orgId);
    if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
    }

    const answered = Boolean(isAnswered);
    const extracted = plivoVoiceAdapter.extractConversationOutcome(transcript);
    const effectiveOutcome = answered
        ? (outcome || extracted.outcome)
        : ASE_OUTCOMES.NO_ANSWER;
    const simUuid = `sim_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const callResult = await Call.create({
        organization_id: orgId,
        lead_id: lead.id,
        provider_call_uuid: simUuid,
        idempotency_key: `sim_${simUuid}`,
        phone_number: lead.phone || "+15550009999",
        call_channel: "VOICE",
        call_type: "OUTBOUND",
        initiation_source: "AUTONOMOUS_AI",
        provider: "plivo_simulator",
        provider_status: answered ? "completed" : "no-answer",
        normalized_outcome: effectiveOutcome,
        business_disposition: answered ? "simulated" : "no_answer",
        is_answered: answered ? 1 : 0,
        duration_sec: answered ? Number(duration) : 0,
        billable_duration_sec: answered ? Number(duration) : 0,
        cost: 0,
        cost_status: "FINAL",
        answered_at: answered ? new Date() : null,
        completed_at: new Date(),
    });

    await OrchestratorService.handleOutcomeEvent(lead, effectiveOutcome, {
        channel: "VOICE",
        simulated: true,
        callId: callResult.call.id,
        callUuid: simUuid,
        transcript: transcript || "",
        duration: answered ? Number(duration) : 0,
        isAnswered: answered,
        callStatus: answered ? "completed" : "no-answer",
    });

    const updatedLead = await Lead.findById(leadId, orgId);
    return res.status(200).json({
        data: {
            lead: updatedLead,
            outcome: effectiveOutcome,
            callId: callResult.call.id,
        },
    });
});

export const getCallHistory = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const { search = "", status = "", source = "", outcome = "", limit = 100, page = 1 } = req.query;

    const p = Math.max(Number(page) || 1, 1);
    const l = Math.min(Math.max(Number(limit) || 100, 1), 200);

    const calls = await Call.list(orgId, {
        search: String(search || ""),
        status: String(status || ""),
        source: String(source || ""),
        outcome: String(outcome || ""),
        limit: l,
        skip: (p - 1) * l,
    });

    const stats = await Call.countStats(orgId);

    const scheduledCalls = await query(
        `SELECT id, name, email, phone, company, status, priority, next_action, next_action_time, attempt_counters, health
         FROM leads
         WHERE organization_id = ?
           AND next_action = 'CALL'
           AND do_not_contact = 0
         ORDER BY next_action_time ASC
         LIMIT 50`,
        [orgId]
    );

    const formattedScheduled = (scheduledCalls || []).map((ld) => {
        let counters = ld.attempt_counters;
        if (typeof counters === "string") {
            try { counters = JSON.parse(counters); } catch { counters = {}; }
        }
        return { ...ld, attempt_counters: counters };
    });

    const formattedCalls = calls.map((c) => {
        let meta = c.raw_metadata;
        if (typeof meta === "string") {
            try { meta = JSON.parse(meta); } catch { meta = {}; }
        }

        const isAnswered = Boolean(c.is_answered);
        const costStr = c.cost !== null && c.cost !== undefined
            ? `$${Number(c.cost).toFixed(4)}`
            : (c.cost_status === "PENDING" ? "Pending" : "Unavailable");

        return {
            id: c.id,
            call_id: c.id,
            call_uuid: c.provider_call_uuid,
            callUuid: c.provider_call_uuid,
            source: c.initiation_source === "MANUAL" ? "manual" : "autonomous",
            direction: c.call_type?.toLowerCase() || "outbound",
            from: c.from_number || process.env.PLIVO_PHONE_NUMBER || null,
            to: c.phone_number,
            status: isAnswered ? "ANSWERED" : (c.provider_status?.toUpperCase() || "COMPLETED"),
            provider_status: c.provider_status,
            normalized_outcome: c.normalized_outcome,
            duration: Number(c.duration_sec || 0),
            billable_duration: Number(c.billable_duration_sec || 0),
            cost: costStr,
            rawCost: c.cost !== null && c.cost !== undefined ? Number(c.cost) : null,
            cost_status: c.cost_status,
            timestamp: c.answered_at || c.created_at || new Date().toISOString(),
            created_at: c.created_at,
            answered_at: c.answered_at,
            completed_at: c.completed_at,
            disposition: c.business_disposition || c.normalized_outcome,
            carrier: meta?.to_number_carrier || null,
            carrierType: meta?.to_number_type || "Mobile",
            isAutonomous: c.initiation_source === "AUTONOMOUS_AI",
            is_autonomous: c.initiation_source === "AUTONOMOUS_AI",
            is_answered: isAnswered,
            isAnswered: isAnswered,
            leadName: c.lead_name || null,
            lead_name: c.lead_name || null,
            leadId: c.lead_id || null,
            lead_id: c.lead_id || null,
            leadCompany: c.lead_company || null,
            lead_company: c.lead_company || null,
            leadEmail: c.lead_email || null,
            lead_email: c.lead_email || null,
            leadPriority: c.lead_priority || null,
            hangupCause: c.hangup_cause || "NORMAL_CLEARING",
            hangup_cause_name: c.hangup_cause || "NORMAL_CLEARING",
            failure_reason: c.failure_reason || null,
            callback_id: c.callback_id || null,
        };
    });

    return res.status(200).json({
        data: {
            calls: formattedCalls,
            plivoCalls: formattedCalls,
            leadCalls: [],
            scheduledCalls: formattedScheduled,
            stats: {
                totalCalls: stats.totalCalls,
                answeredCalls: stats.answeredCalls,
                answerRate: stats.answerRate,
                totalMinutes: stats.totalMinutes,
                totalSeconds: stats.totalSeconds,
                ringingSeconds: stats.ringingSeconds,
                totalCost: stats.totalCost,
                pendingCostCount: stats.pendingCostCount,
                balance: "12.77",
                fromNumber: process.env.PLIVO_PHONE_NUMBER || "+918035087884",
                provider: "plivo",
                configured: plivoVoiceAdapter.isConfigured(),
            },
        },
    });
});

export const getCallDetails = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const callId = req.params.id;

    let call = null;
    if (/^\d+$/.test(callId)) {
        call = await Call.findById(orgId, callId);
    }
    if (!call) {
        call = await Call.findByProviderUuid(orgId, callId);
    }

    if (!call) {
        return res.status(404).json({ error: "Call record not found" });
    }

    const webhookEvents = await TelephonyWebhookEvent.listByCallUuid(call.provider_call_uuid);
    const sanitizedEvents = webhookEvents.map((ev) => {
        let p = ev.payload;
        if (typeof p === "string") {
            try { p = JSON.parse(p); } catch { p = {}; }
        }
        const sanitized = { ...(p || {}) };
        delete sanitized.Authorization;
        delete sanitized.auth_token;
        delete sanitized.password;
        return {
            id: ev.id,
            eventType: ev.event_type,
            createdAt: ev.created_at,
            payload: sanitized,
        };
    });

    return res.status(200).json({
        data: {
            call,
            webhookEvents: sanitizedEvents,
        },
    });
});

export const makeDirectCall = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const { leadId, phone, name, message, from, idempotencyKey } = req.body || {};

    let targetLead = null;
    let targetPhone = phone;
    let targetName = name || "Prospect";

    if (leadId) {
        targetLead = await Lead.findById(leadId, orgId);
        if (!targetLead) {
            return res.status(404).json({ error: "Lead not found" });
        }
        if (targetLead.do_not_contact) {
            return res.status(400).json({ error: "Lead is flagged as Do Not Contact (DNC)" });
        }
        targetPhone = (phone && String(phone).trim()) ? String(phone).trim() : targetLead.phone;
        targetName = (name && String(name).trim()) ? String(name).trim() : (targetLead.name || targetName);
    } else if (targetPhone) {
        const norm = normalizePhone(targetPhone);
        if (norm) {
            const matchedRows = await query(
                `SELECT id, name, email, phone, company, status, priority, attempt_counters, do_not_contact
                 FROM leads
                 WHERE organization_id = ? AND (phone = ? OR phone LIKE ?)
                 LIMIT 1`,
                [orgId, targetPhone, `%${norm}`]
            );
            if (matchedRows && matchedRows.length > 0) {
                targetLead = matchedRows[0];
                if (targetLead.do_not_contact) {
                    return res.status(400).json({ error: "Lead is flagged as Do Not Contact (DNC)" });
                }
                targetName = targetLead.name || targetName;
            }
        }
    }

    if (!targetPhone) {
        return res.status(400).json({ error: "A valid phone number is required to make a call" });
    }

    const resolvedKey = idempotencyKey || `manual_${orgId}_${targetLead?.id || targetPhone}_${Date.now()}`;
    const callResult = await Call.create({
        organization_id: orgId,
        lead_id: targetLead?.id || null,
        idempotency_key: resolvedKey,
        phone_number: targetPhone,
        from_number: from || process.env.PLIVO_PHONE_NUMBER || null,
        call_channel: "VOICE",
        call_type: "OUTBOUND",
        initiation_source: "MANUAL",
        provider: "plivo",
        provider_status: "initiated",
        normalized_outcome: "INITIATED",
        cost_status: "PENDING",
    });

    const leadObject = {
        ...(targetLead || {}),
        id: targetLead?.id || null,
        name: targetName,
        phone: targetPhone,
        organization_id: orgId,
    };

    const result = await plivoVoiceAdapter.execute(leadObject, "CALL", {
        prompt: message,
        from,
        callId: callResult.call.id,
        requireRealProvider: Boolean(req.body.requireRealProvider),
    });

    if (result.status === "SUCCEEDED") {
        const providerUuid = result.metadata?.providerCallId || result.metadata?.callId;
        const updatedCall = await Call.updateById(orgId, callResult.call.id, {
            provider_call_uuid: providerUuid,
            provider_status: "initiated",
            normalized_outcome: "INITIATED",
        });
        schedulePlivoCallSync(updatedCall || { ...callResult.call, provider_call_uuid: providerUuid });

        if (targetLead) {
            const counters = typeof targetLead.attempt_counters === "string"
                ? JSON.parse(targetLead.attempt_counters || "{}")
                : (targetLead.attempt_counters || { email: 0, voice: 0, total: 0 });
            counters.voice = (counters.voice || 0) + 1;
            counters.total = (counters.total || 0) + 1;

            await Lead.updateById(
                targetLead.id,
                {
                    attempt_counters: counters,
                    last_contacted_at: new Date(),
                    status: targetLead.status === "NEW" ? "CONTACTED" : targetLead.status,
                },
                orgId
            );

            await eventBus.publish("ActionDispatched", {
                organization_id: orgId,
                lead_id: targetLead.id,
                channel: "VOICE",
                action: "CALL",
                call_id: callResult.call.id,
                payload: {
                    manual: true,
                    phone: targetPhone,
                    provider: "plivo",
                    callId: providerUuid,
                    prompt: message,
                },
            });
        }

        return res.status(200).json({ data: { ...result, callId: callResult.call.id } });
    } else {
        await Call.updateById(orgId, callResult.call.id, {
            provider_status: "request_failed",
            normalized_outcome: "FAILED",
            failure_reason: result.error,
        });
        return res.status(400).json({ data: { ...result, callId: callResult.call.id } });
    }
});

export const triggerAutonomousCall = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const { leadId } = req.body || {};

    if (!leadId) {
        return res.status(400).json({ error: "leadId is required" });
    }

    let lead = await Lead.findById(leadId, orgId);
    if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
    }
    if (lead.do_not_contact) {
        return res.status(400).json({ error: "Lead is suppressed (DNC)" });
    }
    if (!lead.phone) {
        return res.status(400).json({ error: "Lead has no phone number" });
    }
    const trigDigits = String(lead.phone || "").replace(/[^\d]/g, "");
    if (trigDigits.length < 10 || trigDigits.length > 15) {
        return res.status(400).json({ error: "Lead phone number is unverified or invalid" });
    }

    lead = await Lead.updateById(
        lead.id,
        {
            next_action: "CALL",
            next_action_time: new Date(),
            status: "DISPATCH_CALL",
        },
        orgId
    );

    const mode = await getOperatingMode(orgId);
    if (mode === OPERATING_MODES.AI_RECOMMENDED) {
        const queued = await enqueuePendingApproval({
            organizationId: orgId,
            leadId: lead.id,
            action: "CALL",
            payload: { source: "autonomous_call_ui" },
        });
        return res.status(200).json({
            data: {
                lead,
                executed: false,
                queued: true,
                approvalId: queued.approval?.id || null,
                action: "CALL",
                operatingMode: mode,
            },
        });
    }

    const flags = executionFlagsForMode(mode, { humanInitiated: true });
    const result = await aseScheduler.processLeadAction(lead, flags);
    const updated = await Lead.findById(lead.id, orgId);

    return res.status(result?.executed ? 200 : 400).json({
        data: {
            lead: updated,
            executed: Boolean(result?.executed),
            action: "CALL",
            reason: result?.reason || null,
        },
        error: result?.executed ? undefined : (result?.reason || "Call did not execute"),
    });
});

export const queueAutonomousCall = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const { leadId, delayMinutes = 0 } = req.body || {};

    if (!leadId) {
        return res.status(400).json({ error: "leadId is required" });
    }

    const lead = await Lead.findById(leadId, orgId);
    if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
    }
    if (lead.do_not_contact) {
        return res.status(400).json({ error: "Lead is suppressed (DNC)" });
    }
    if (!lead.phone) {
        return res.status(400).json({ error: "Lead has no phone number" });
    }
    const queueDigits = String(lead.phone || "").replace(/[^\d]/g, "");
    if (queueDigits.length < 10 || queueDigits.length > 15) {
        return res.status(400).json({ error: "Lead phone number is unverified or invalid" });
    }

    const scheduledTime = new Date(Date.now() + Math.max(0, Number(delayMinutes)) * 60 * 1000);
    const updated = await Lead.updateById(
        lead.id,
        {
            status: "QUEUED",
            next_action: "CALL",
            next_action_time: scheduledTime,
        },
        orgId
    );

    if (Number(delayMinutes) <= 0) {
        aseScheduler.kick();
    }

    return res.status(200).json({ data: { lead: updated, scheduledTime } });
});

function flattenVoicePayload(req) {
    const payload = { ...(req.query || {}), ...(req.body || {}) };
    const nested = [payload.variables, payload.data, payload.result, payload.payload, payload.call]
        .filter((value) => value && typeof value === "object" && !Array.isArray(value));
    return Object.assign({}, ...nested, payload);
}

export const handleAgentflowOutcome = asyncHandler(async (req, res) => {
    const payload = flattenVoicePayload(req);
    const transcript = extractCallTranscript(payload);
    const rawStatus = payload.CallStatus || payload.call_status || payload.Status || payload.status;
    const merged = {
        ...payload,
        CallUUID: payload.CallUUID || payload.call_uuid || payload.request_uuid || payload.callUuid,
        CallStatus: rawStatus,
        SpeechResult: transcript,
        transcript,
        Duration: payload.Duration || payload.duration || payload.call_duration || 0,
        leadId: payload.leadId || payload.lead_id,
        orgId: payload.orgId || payload.organization_id,
        HangupCause: payload.HangupCause || payload.hangup_cause || payload.disposition || payload.call_disposition,
        callId: payload.callId || payload.call_id,
        channel: "VOICE",
    };
    const looksFinished = isFinishedCallEvent(merged);

    if (!looksFinished && (transcript || payload.disposition || payload.call_disposition)) {
        const live = await handleLiveVoiceInterest({
            ...merged,
            CallStatus: rawStatus || "in-progress",
        });
        if (live?.handled) {
            return res.status(200).json(live);
        }
    }

    req.body = {
        ...(req.query || {}),
        ...merged,
        CallStatus: rawStatus || (looksFinished ? "completed" : "in-progress"),
    };
    return handlePlivoStatus(req, res);
});

export const runSchedulerCycle = asyncHandler(async (_req, res) => {
    aseScheduler.kick();
    return res.status(200).json({
        data: {
            message: "Autonomous outreach cycle kicked successfully",
            timestamp: new Date().toISOString(),
        },
    });
});

import { plivoVoiceAdapter } from "../../services/ase/adapters/plivoVoice.adapter.js";
import { OrchestratorService } from "../../services/ase/orchestrator.service.js";
import { Lead } from "../../models/lead.model.js";
import { Call } from "../../models/call.model.js";
import { TelephonyWebhookEvent } from "../../models/telephony-webhook-event.model.js";
import { aseScheduler } from "../../services/ase/scheduler.service.js";
import { eventBus } from "../../services/ase/eventBus.service.js";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { normalizeTelephonyOutcome, ASE_OUTCOMES } from "../../services/ase/outcomeNormalizer.service.js";

const normalizePhone = (num) => {
    if (!num) return "";
    return String(num).replace(/\D/g, "").slice(-10);
};

export const handlePlivoAnswer = asyncHandler(async (req, res) => {
    const payload = { ...(req.query || {}), ...(req.body || {}) };
    const callUuid = payload.CallUUID || payload.CallId || payload.request_uuid;
    const orgId = Number(payload.orgId || payload.organization_id || 1);
    const leadName = payload.leadName || "there";
    const customMessage = payload.message;

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

    const xml = plivoVoiceAdapter.generateAnswerXml({
        message: customMessage,
        leadName,
    });

    res.set("Content-Type", "application/xml");
    return res.status(200).send(xml);
});

export const handlePlivoStatus = asyncHandler(async (req, res) => {
    const payload = { ...(req.query || {}), ...(req.body || {}) };
    const callUuid = payload.CallUUID || payload.CallId || payload.request_uuid;
    const orgId = Number(payload.orgId || payload.organization_id || 1);
    const callStatus = String(payload.CallStatus || payload.Status || payload.call_status || "unknown");
    const rawDuration = Number(payload.Duration || payload.call_duration || 0);
    const rawBillDuration = Number(payload.BillDuration || payload.billed_duration || 0);
    const hangupCause = payload.HangupCause || payload.hangup_cause_name || null;
    const totalAmount = payload.TotalAmount || payload.total_amount || null;
    const answerTime = payload.AnswerTime || payload.answer_time || null;
    const endTime = payload.EndTime || payload.end_time || null;
    const speechResult = payload.SpeechResult || payload.transcript || payload.Text || "";

    const dedup = await TelephonyWebhookEvent.recordEvent({
        organization_id: orgId,
        provider: "plivo",
        provider_call_uuid: callUuid,
        event_type: callStatus,
        payload,
    });

    if (dedup.isDuplicate) {
        return res.status(200).json({ status: "duplicate_ignored", callUuid });
    }

    const normalized = normalizeTelephonyOutcome({
        ...payload,
        CallStatus: callStatus,
        Duration: rawDuration,
        BillDuration: rawBillDuration,
        HangupCause: hangupCause,
        AnswerTime: answerTime,
        SpeechResult: speechResult,
    });

    let existingCall = null;
    if (callUuid) {
        existingCall = await Call.findByProviderUuid(orgId, callUuid);
    }

    if (!existingCall && payload.callId) {
        existingCall = await Call.findById(orgId, payload.callId);
    }

    if (!existingCall && callUuid) {
        const createResult = await Call.create({
            organization_id: orgId,
            lead_id: payload.leadId ? Number(payload.leadId) : null,
            provider_call_uuid: callUuid,
            phone_number: payload.To || payload.to || "Unknown",
            from_number: payload.From || payload.from || null,
            call_channel: "VOICE",
            call_type: "OUTBOUND",
            initiation_source: payload.manual ? "MANUAL" : "AUTONOMOUS_AI",
            provider_status: callStatus,
            normalized_outcome: normalized.normalizedOutcome,
            business_disposition: normalized.disposition,
            is_answered: normalized.isAnswered ? 1 : 0,
            duration_sec: rawDuration,
            billable_duration_sec: rawBillDuration,
            cost: totalAmount ? Number(totalAmount) : null,
            cost_status: totalAmount ? "FINAL" : "PENDING",
            hangup_cause: hangupCause,
            answered_at: answerTime ? new Date(answerTime) : (normalized.isAnswered ? new Date() : null),
            completed_at: endTime ? new Date(endTime) : new Date(),
            raw_metadata: payload,
        });
        existingCall = createResult.call;
    } else if (existingCall) {
        const callUpdates = {
            provider_status: callStatus,
            normalized_outcome: normalized.normalizedOutcome,
            duration_sec: Math.max(existingCall.duration_sec || 0, rawDuration),
            billable_duration_sec: Math.max(existingCall.billable_duration_sec || 0, rawBillDuration),
            hangup_cause: hangupCause || existingCall.hangup_cause,
            raw_metadata: payload,
        };

        if (normalized.disposition && normalized.disposition !== "unspecified") {
            callUpdates.business_disposition = normalized.disposition;
        }

        if (normalized.isAnswered) {
            callUpdates.is_answered = 1;
            if (!existingCall.answered_at) {
                callUpdates.answered_at = answerTime ? new Date(answerTime) : new Date();
            }
        }

        if (totalAmount !== null && totalAmount !== undefined) {
            callUpdates.cost = Number(totalAmount);
            callUpdates.cost_status = "FINAL";
        }

        const isTerminal = [
            "completed",
            "busy",
            "no-answer",
            "timeout",
            "failed",
            "canceled",
            "cancelled",
            "rejected",
        ].includes(callStatus.toLowerCase());

        if (isTerminal && !existingCall.completed_at) {
            callUpdates.completed_at = endTime ? new Date(endTime) : new Date();
        }

        existingCall = await Call.updateById(orgId, existingCall.id, callUpdates);
    }

    const leadId = payload.leadId || payload.lead_id || existingCall?.lead_id;
    if (leadId) {
        const lead = await Lead.findById(leadId, orgId);
        if (lead) {
            const isFinalState = [
                "completed",
                "busy",
                "no-answer",
                "timeout",
                "failed",
                "canceled",
                "cancelled",
                "rejected",
            ].includes(callStatus.toLowerCase());

            if (isFinalState) {
                if (normalized.isAnswered) {
                    await Lead.updateById(
                        lead.id,
                        {
                            status: lead.status === "NEW" || lead.status === "DISPATCH_CALL" ? "CONTACTED" : lead.status,
                            last_contacted_at: new Date(),
                        },
                        orgId
                    );

                    if (
                        normalized.normalizedOutcome === ASE_OUTCOMES.CALLBACK ||
                        normalized.normalizedOutcome === ASE_OUTCOMES.INTERESTED ||
                        normalized.normalizedOutcome === ASE_OUTCOMES.DNC ||
                        normalized.normalizedOutcome === ASE_OUTCOMES.NOT_INTERESTED
                    ) {
                        await OrchestratorService.handleOutcomeEvent(lead, normalized.normalizedOutcome, {
                            channel: "VOICE",
                            provider: "plivo",
                            callStatus,
                            callUuid,
                            callId: existingCall?.id,
                            duration: rawDuration,
                            transcript: speechResult,
                            disposition: normalized.disposition,
                            rawPayload: payload,
                        });
                    }

                    await eventBus.publish("CallCompleted", {
                        organization_id: orgId,
                        lead_id: lead.id,
                        channel: "VOICE",
                        call_id: existingCall?.id,
                        provider_call_uuid: callUuid,
                        duration: rawDuration,
                        outcome: normalized.normalizedOutcome,
                        disposition: normalized.disposition,
                    });
                } else {
                    await eventBus.publish("CallFailed", {
                        organization_id: orgId,
                        lead_id: lead.id,
                        channel: "VOICE",
                        call_id: existingCall?.id,
                        provider_call_uuid: callUuid,
                        reason: normalized.reason || hangupCause || callStatus,
                        outcome: normalized.normalizedOutcome,
                    });
                }
            }
        }
    }

    return res.status(200).json({
        status: "received",
        callStatus,
        normalizedOutcome: normalized.normalizedOutcome,
        isAnswered: normalized.isAnswered,
        disposition: normalized.disposition,
        callId: existingCall?.id,
    });
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
        await Call.updateById(orgId, callResult.call.id, {
            provider_call_uuid: result.metadata?.providerCallId,
            provider_status: "initiated",
            normalized_outcome: "INITIATED",
        });
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

    const effectiveOutcome = outcome || plivoVoiceAdapter.extractConversationOutcome(transcript).outcome;
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
        provider_status: isAnswered ? "completed" : "no-answer",
        normalized_outcome: isAnswered ? effectiveOutcome : ASE_OUTCOMES.NO_ANSWER,
        business_disposition: isAnswered ? "simulated" : "no_answer",
        is_answered: isAnswered ? 1 : 0,
        duration_sec: isAnswered ? Number(duration) : 0,
        billable_duration_sec: isAnswered ? Number(duration) : 0,
        cost: 0,
        cost_status: "FINAL",
        answered_at: isAnswered ? new Date() : null,
        completed_at: new Date(),
    });

    await OrchestratorService.handleOutcomeEvent(lead, effectiveOutcome, {
        channel: "VOICE",
        simulated: true,
        callId: callResult.call.id,
        callUuid: simUuid,
        transcript: transcript || "",
        duration: isAnswered ? Number(duration) : 0,
        isAnswered,
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
        targetPhone = targetLead.phone;
        targetName = targetLead.name || targetName;
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

    const leadObject = targetLead || {
        id: null,
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
        await Call.updateById(orgId, callResult.call.id, {
            provider_call_uuid: providerUuid,
            provider_status: "initiated",
            normalized_outcome: "INITIATED",
        });

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

    lead = await Lead.updateById(
        lead.id,
        {
            next_action: "CALL",
            next_action_time: new Date(),
            status: "DISPATCH_CALL",
        },
        orgId
    );

    await aseScheduler.processLeadAction(lead);
    const updated = await Lead.findById(lead.id, orgId);

    return res.status(200).json({
        data: {
            lead: updated,
            executed: true,
            action: "CALL",
        },
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

export const runSchedulerCycle = asyncHandler(async (_req, res) => {
    aseScheduler.kick();
    return res.status(200).json({
        data: {
            message: "Autonomous outreach cycle kicked successfully",
            timestamp: new Date().toISOString(),
        },
    });
});

import { OrchestratorService } from "./orchestrator.service.js";
import { Lead } from "../../models/lead.model.js";
import { Call } from "../../models/call.model.js";
import { TelephonyWebhookEvent } from "../../models/telephony-webhook-event.model.js";
import { eventBus } from "./eventBus.service.js";
import { normalizeTelephonyOutcome, extractCallTranscript } from "./outcomeNormalizer.service.js";
import { isClickToCallRecord, parseCallMeta } from "./clickToCall.service.js";
import { handleCallEvent, isCadenceCall } from "./cadence/cadence.service.js";

const TERMINAL_STATUSES = new Set([
    "completed",
    "busy",
    "no-answer",
    "timeout",
    "failed",
    "canceled",
    "cancelled",
    "rejected",
]);

export async function applyPlivoCallPayload(rawPayload = {}) {
    const payload = { ...(rawPayload || {}) };
    const callUuid = payload.CallUUID || payload.CallId || payload.request_uuid;
    let orgId = Number(payload.orgId || payload.organization_id || 0);
    const callStatus = String(payload.CallStatus || payload.Status || payload.call_status || "unknown");
    const rawDuration = Number(payload.Duration || payload.call_duration || 0);
    const rawBillDuration = Number(payload.BillDuration || payload.billed_duration || 0);
    const hangupCause = payload.HangupCause || payload.hangup_cause_name || null;
    const totalAmount = payload.TotalAmount || payload.total_amount || null;
    const answerTime = payload.AnswerTime || payload.answer_time || null;
    const endTime = payload.EndTime || payload.end_time || null;
    const speechResult = extractCallTranscript(payload);

    const dedup = await TelephonyWebhookEvent.recordEvent({
        organization_id: orgId,
        provider: payload.source === "plivo_poll" ? "plivo_poll" : "plivo",
        provider_call_uuid: callUuid,
        event_type: callStatus,
        payload,
    });

    if (dedup.isDuplicate) {
        return { status: "duplicate_ignored", callUuid };
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
    if (payload.source === "plivo_poll" && payload.callId) {
        existingCall = orgId
            ? await Call.findById(orgId, payload.callId)
            : await Call.findByIdAnyOrg(payload.callId);
        if (!existingCall) {
            existingCall = await Call.findByIdAnyOrg(payload.callId);
        }
        if (existingCall?.organization_id) {
            orgId = Number(existingCall.organization_id);
        }
    }

    if (!existingCall && callUuid) {
        existingCall = await Call.findByProviderUuidAnyOrg(callUuid);
        if (existingCall?.organization_id) {
            orgId = Number(existingCall.organization_id);
        }
    }

    if (!existingCall && payload.callId) {
        existingCall = orgId
            ? await Call.findById(orgId, payload.callId)
            : await Call.findByIdAnyOrg(payload.callId);
        if (!existingCall) {
            existingCall = await Call.findByIdAnyOrg(payload.callId);
        }
        if (existingCall?.organization_id) {
            orgId = Number(existingCall.organization_id);
        }
    }

    if (!existingCall && callUuid && payload.leadId && orgId) {
        const knownLead = await Lead.findById(payload.leadId, orgId).catch(() => null);
        if (!knownLead) {
            return { status: "ignored", reason: "Unknown call and lead for organization" };
        }
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
        const prevMeta = parseCallMeta(existingCall.raw_metadata);
        const clickToCall = isClickToCallRecord(existingCall) || prevMeta.mode === "click_to_call";
        const callUpdates = {
            provider_status: clickToCall ? existingCall.provider_status : callStatus,
            normalized_outcome: clickToCall ? existingCall.normalized_outcome : normalized.normalizedOutcome,
            duration_sec: Math.max(existingCall.duration_sec || 0, clickToCall ? (prevMeta.connectedDurationSec || 0) : rawDuration),
            billable_duration_sec: Math.max(existingCall.billable_duration_sec || 0, rawBillDuration),
            hangup_cause: hangupCause || existingCall.hangup_cause,
            raw_metadata: clickToCall
                ? { ...prevMeta, lastProviderStatus: callStatus, lastHangupCause: hangupCause }
                : payload,
        };

        if (payload.CallUUID && payload.CallUUID !== existingCall.provider_call_uuid) {
            callUpdates.provider_call_uuid = payload.CallUUID;
        }

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

        if (TERMINAL_STATUSES.has(callStatus.toLowerCase()) && !existingCall.completed_at && !clickToCall) {
            callUpdates.completed_at = endTime ? new Date(endTime) : new Date();
        }

        existingCall = await Call.updateById(orgId, existingCall.id, callUpdates);
    }

    const leadId = payload.leadId || payload.lead_id || existingCall?.lead_id;
    const isFinalState = TERMINAL_STATUSES.has(callStatus.toLowerCase());
    const skipAutonomous = isClickToCallRecord(existingCall);
    const cadenceCall = !skipAutonomous && orgId ? await isCadenceCall(orgId, existingCall).catch(() => false) : false;
    if (cadenceCall && !isFinalState) {
        await handleCallEvent({ orgId, call: existingCall, callStatus, normalized, hangupCause, duration: rawDuration, isFinal: false })
            .catch((err) => console.error("[PlivoStatus] Cadence progress update failed:", err.message));
    }
    if (leadId && orgId && isFinalState) {
        const lead = await Lead.findById(leadId, orgId);
        if (lead) {
            if (normalized.isAnswered) {
                await Lead.updateById(
                    lead.id,
                    {
                        status: lead.status === "NEW" || lead.status === "DISPATCH_CALL" ? "CONTACTED" : lead.status,
                        last_contacted_at: new Date(),
                    },
                    orgId
                );
            }

            if (!skipAutonomous) {
                await OrchestratorService.handleOutcomeEvent(lead, normalized.normalizedOutcome, {
                    channel: "VOICE",
                    provider: "plivo",
                    callStatus,
                    callUuid,
                    callId: existingCall?.id,
                    duration: rawDuration,
                    transcript: speechResult,
                    disposition: normalized.disposition,
                    isAnswered: normalized.isAnswered,
                    rawPayload: payload,
                    skipNextActionSchedule: cadenceCall,
                }).catch((err) => console.error("[PlivoStatus] Outcome handling failed:", err.message));
            }

            if (cadenceCall) {
                await handleCallEvent({ orgId, call: existingCall, callStatus, normalized, hangupCause, duration: rawDuration, isFinal: true })
                    .catch((err) => console.error("[PlivoStatus] Cadence outcome handling failed:", err.message));
            }

            await eventBus.publish(normalized.isAnswered ? "CallCompleted" : "CallFailed", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: "VOICE",
                call_id: existingCall?.id,
                provider_call_uuid: callUuid,
                duration: rawDuration,
                outcome: normalized.normalizedOutcome,
                disposition: normalized.disposition,
                reason: normalized.reason || hangupCause || callStatus,
            });
        }
    }

    return {
        status: "received",
        callStatus,
        normalizedOutcome: normalized.normalizedOutcome,
        isAnswered: normalized.isAnswered,
        disposition: normalized.disposition,
        callId: existingCall?.id,
    };
}

import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { AseExecution } from "../../models/ase-execution.model.js";
import { Callback } from "../../models/callback.model.js";
import { Call } from "../../models/call.model.js";
import { emailAdapter } from "./adapters/email.adapter.js";
import { voiceAdapter } from "./adapters/voice.adapter.js";
import { normalizeChannelOutcome, ASE_OUTCOMES } from "./outcomeNormalizer.service.js";
import { OrchestratorService } from "./orchestrator.service.js";
import { validateDispatchEligibility } from "./complianceGate.service.js";
import { transitionLeadState } from "./leadStateMachine.js";
import { eventBus } from "./eventBus.service.js";
import { followUpEngine } from "../followup/followUpEngine.service.js";
import { followUpScheduler } from "../followup/followUpScheduler.service.js";
import { isCompanyResearchPending } from "./companyResearch.service.js";
import { calculateNextCallingTime } from "./callingHours.service.js";
import { applyOperatingModeGate } from "./operatingModeGate.service.js";
import { pollOpenPlivoCalls, schedulePlivoCallSync } from "./plivoCallPoll.service.js";
import { env } from "../../config/env.js";

class AseScheduler {
    constructor() {
        this.isRunning = false;
        this.timer = null;
        this.pollIntervalMs = 15000;
        this.cycleRunning = false;
        this.pendingKick = false;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.poll();
    }

    stop() {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    kick() {
        if (!this.isRunning) return;
        if (this.cycleRunning) {
            this.pendingKick = true;
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.poll();
    }

    async poll() {
        if (!this.isRunning) return;
        if (this.cycleRunning) {
            this.pendingKick = true;
            return;
        }
        this.cycleRunning = true;
        this.pendingKick = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        try {
            await this.autoQueueNewLeads();
            await this.executeDueActions();
            await this.checkOverdueCallbacks();
            await followUpScheduler.processDueTasks().catch(() => {});
            await pollOpenPlivoCalls().catch((err) => {
                console.warn("[ASE Scheduler] Plivo call poll failed:", err.message);
            });
        } catch (error) {
            console.error("[ASE Scheduler] Error during cycle:", error.message);
        } finally {
            this.cycleRunning = false;
            if (!this.isRunning) return;
            if (this.pendingKick) {
                this.pendingKick = false;
                setTimeout(() => this.poll(), 0);
                return;
            }
            this.timer = setTimeout(() => this.poll(), this.pollIntervalMs);
        }
    }

    async autoQueueNewLeads() {
        try {
            const unscheduled = await Lead.findUnscheduledNew(10);
            for (const lead of unscheduled) {
                if (isCompanyResearchPending(lead)) continue;
                const orgId = Number(lead.organization_id || 1);
                const decision = await OrchestratorService.evaluateNextAction(lead);
                if (decision && decision.action) {
                    const nextStatus = transitionLeadState(
                        lead.status,
                        decision.action === "EMAIL" ? "DISPATCH_EMAIL" : "DISPATCH_CALL"
                    ).nextState || "QUEUED";

                    await Lead.updateById(
                        lead.id,
                        {
                            status: nextStatus,
                            next_action: decision.action,
                            next_action_time: decision.scheduledTime || new Date(),
                        },
                        orgId
                    );

                    await eventBus.publish("ActionScheduled", {
                        organization_id: orgId,
                        lead_id: lead.id,
                        channel: decision.channel || "SYSTEM",
                        action: decision.action,
                        scheduled_time: decision.scheduledTime || new Date(),
                    });
                }
            }
        } catch (err) {
            console.error("[ASE Scheduler] Failed autoQueueNewLeads:", err.message);
        }
    }

    async executeDueActions() {
        const dueLeads = await Lead.findDueForAction(10);
        if (dueLeads.length === 0) return;

        for (const lead of dueLeads) {
            await this.processLeadAction(lead);
        }
    }

    async processLeadAction(lead, options = {}) {
        const orgId = Number(lead.organization_id || 1);
        const action = lead.next_action;
        const freshLead = await Lead.findById(lead.id, orgId);
        const force = Boolean(options.force);
        const skipTiming = force || env.bypassTimingGates;

        if (!freshLead || freshLead.do_not_contact || freshLead.next_action !== action) {
            return { executed: false, reason: "Lead missing, DNC, or action changed" };
        }

        const dispatchGate = await applyOperatingModeGate(freshLead, action, {
            approved: Boolean(options.approved),
            manual: Boolean(options.manual),
        });
        if (!dispatchGate.allowed) {
            return {
                executed: false,
                reason: dispatchGate.reason,
                queued: Boolean(dispatchGate.queued),
                approvalId: dispatchGate.approval?.id || null,
            };
        }

        if (action === "EMAIL" && !skipTiming && isCompanyResearchPending(freshLead)) {
            return { executed: false, reason: "Company research still pending" };
        }

        const timeStr = freshLead.next_action_time ? new Date(freshLead.next_action_time).toISOString() : new Date().toISOString();
        const idempotencyKey = `exec_${orgId}_${freshLead.id}_${action}_${timeStr}`;

        let claim = await AseExecution.claim({
            organization_id: orgId,
            lead_id: freshLead.id,
            idempotency_key: idempotencyKey,
            action_type: action,
        });

        if (!claim.claimed) {
            const existing = claim.existing;
            if (existing && existing.status === "PROCESSING") {
                const createdAt = new Date(existing.created_at || existing.createdAt || 0).getTime();
                if (Date.now() - createdAt > 45000) {
                    await AseExecution.complete(existing.id, "FAILED", { error: "Execution lock expired" });
                    const retry = await AseExecution.claim({
                        organization_id: orgId,
                        lead_id: freshLead.id,
                        idempotency_key: `${idempotencyKey}_retry_${Date.now()}`,
                        action_type: action,
                    });
                    if (!retry.claimed) {
                        return { executed: false, reason: "Execution already in progress" };
                    }
                    claim = retry;
                } else {
                    return { executed: false, reason: "Execution already in progress" };
                }
            } else {
                return { executed: false, reason: "Duplicate execution claim" };
            }
        }

        if (skipTiming) {
            console.log(`[ASE Scheduler] Timing gates bypassed for lead ${freshLead.id} action=${action}`);
        }

        const eligibility = await validateDispatchEligibility(freshLead, action, {
            isEngagementTrigger: skipTiming || action === "CALL",
            bypassCallingHours: skipTiming,
            bypassCooldown: skipTiming,
        });
        if (!eligibility.eligible) {
            await AseExecution.complete(claim.executionId, "CANCELLED", { reason: eligibility.reason });
            const hoursBlock = /calling hours/i.test(eligibility.reason || "");
            if (action === "CALL" && hoursBlock) {
                const later = calculateNextCallingTime(freshLead, { delaySeconds: 0 });
                await Lead.updateById(
                    freshLead.id,
                    { next_action: "CALL", next_action_time: later },
                    orgId
                );
                return { executed: false, reason: eligibility.reason, rescheduled: true };
            }
            const keepEmail = action === "EMAIL" && !/consent|suppressed|do_not_contact|terminal/i.test(eligibility.reason || "");
            await Lead.updateById(
                freshLead.id,
                {
                    next_action: keepEmail ? "EMAIL" : null,
                    next_action_time: keepEmail ? new Date(Date.now() + 15 * 60 * 1000) : null,
                },
                orgId
            );
            await eventBus.publish("ActionFailed", {
                organization_id: orgId,
                lead_id: freshLead.id,
                channel: "SYSTEM",
                action,
                reason: eligibility.reason,
            });
            return { executed: false, reason: eligibility.reason };
        }

        try {
            let result;
            let channel = action === "EMAIL" ? "EMAIL" : "VOICE";
            let callRecord = null;

            if (action === "CALL") {
                const callResult = await Call.create({
                    organization_id: orgId,
                    lead_id: freshLead.id,
                    idempotency_key: idempotencyKey,
                    phone_number: freshLead.phone,
                    call_channel: "VOICE",
                    call_type: "OUTBOUND",
                    initiation_source: "AUTONOMOUS_AI",
                    provider: "plivo",
                    provider_status: "initiated",
                    normalized_outcome: "INITIATED",
                    cost_status: "PENDING",
                });
                callRecord = callResult.call;

                await eventBus.publish("ActionDispatched", {
                    organization_id: orgId,
                    lead_id: freshLead.id,
                    channel: "VOICE",
                    action: "CALL",
                    execution_id: claim.executionId,
                    call_id: callRecord.id,
                });

                result = await voiceAdapter.execute(freshLead, "CALL", {
                    callId: callRecord.id,
                });

                if (result.status !== "SUCCEEDED") {
                    await Call.updateById(orgId, callRecord.id, {
                        provider_status: "request_failed",
                        normalized_outcome: "FAILED",
                        failure_reason: result.error || "Provider call creation rejected",
                    });
                    await AseExecution.complete(claim.executionId, "FAILED", { error: result.error });
                    await Lead.updateById(
                        freshLead.id,
                        {
                            status: freshLead.status === "NEW" || freshLead.status === "QUEUED" ? "CONTACTED" : freshLead.status,
                            next_action: "CALL",
                            next_action_time: new Date(Date.now() + 15 * 60 * 1000),
                        },
                        orgId
                    );
                    await eventBus.publish("ActionFailed", {
                        organization_id: orgId,
                        lead_id: freshLead.id,
                        channel: "VOICE",
                        action: "CALL",
                        call_id: callRecord.id,
                        status: result.status,
                        metadata: result.metadata || { error: result.error },
                    });
                    return { executed: false, reason: result.error || "Call provider rejected the request" };
                }

                const providerUuid = result.metadata?.providerCallId || result.metadata?.callId;
                const initiatedCall = await Call.updateById(orgId, callRecord.id, {
                    provider_call_uuid: providerUuid,
                    provider_status: "initiated",
                    normalized_outcome: "INITIATED",
                });
                schedulePlivoCallSync(initiatedCall || { ...callRecord, provider_call_uuid: providerUuid });

                const currentCounters = freshLead.attempt_counters || { email: 0, voice: 0, total: 0 };
                currentCounters.voice = (currentCounters.voice || 0) + 1;
                currentCounters.total = (currentCounters.total || 0) + 1;

                const stateTransition = transitionLeadState(freshLead.status, "CALL_INITIATED");
                const nextStatus = stateTransition.nextState;

                await Lead.updateById(
                    freshLead.id,
                    {
                        status: nextStatus,
                        attempt_counters: currentCounters,
                        last_contacted_at: new Date(),
                        next_action: null,
                        next_action_time: null,
                    },
                    orgId
                );

                if (result.rawResponse?.simulated || result.metadata?.simulated) {
                    await OrchestratorService.handleOutcomeEvent(
                        { ...freshLead, status: nextStatus, attempt_counters: currentCounters },
                        ASE_OUTCOMES.AMBIGUOUS,
                        {
                            channel: "VOICE",
                            simulated: true,
                            isAnswered: false,
                            callStatus: "completed",
                            callId: callRecord.id,
                        }
                    ).catch((err) => console.error("[ASE] Simulated call outcome failed:", err.message));
                }

                await eventBus.publish("ActionCompleted", {
                    organization_id: orgId,
                    lead_id: freshLead.id,
                    channel: "VOICE",
                    action: "CALL",
                    status: result.status,
                    call_id: callRecord.id,
                    provider_call_uuid: providerUuid,
                    metadata: result.metadata || {},
                });

                if (stateTransition.changed) {
                    await eventBus.publish("LeadStateChanged", {
                        organization_id: orgId,
                        lead_id: freshLead.id,
                        channel: "VOICE",
                        from_state: freshLead.status,
                        to_state: nextStatus,
                    });
                }

                await AseExecution.complete(claim.executionId, "SUCCEEDED", result.metadata);
                return { executed: true, action: "CALL", callId: callRecord.id };
            } else if (action === "EMAIL") {
                await eventBus.publish("ActionDispatched", {
                    organization_id: orgId,
                    lead_id: freshLead.id,
                    channel: "EMAIL",
                    action: "EMAIL",
                    execution_id: claim.executionId,
                });

                result = await emailAdapter.execute(freshLead, "SEND");

                if (result.status !== "SUCCEEDED") {
                    await AseExecution.complete(claim.executionId, "FAILED", { error: result.error });
                    await Lead.updateById(
                        freshLead.id,
                        {
                            status: "QUEUED",
                            next_action: "EMAIL",
                            next_action_time: new Date(Date.now() + 15 * 60 * 1000),
                        },
                        orgId
                    );
                    await eventBus.publish("ActionFailed", {
                        organization_id: orgId,
                        lead_id: freshLead.id,
                        channel: "EMAIL",
                        action: "EMAIL",
                        status: result.status,
                        metadata: result.metadata || { error: result.error },
                    });
                    return { executed: false, reason: result.error || "Email delivery failed" };
                }

                const currentCounters = freshLead.attempt_counters || { email: 0, voice: 0, total: 0 };
                currentCounters.email = (currentCounters.email || 0) + 1;
                currentCounters.total = (currentCounters.total || 0) + 1;

                const stateTransition = transitionLeadState(freshLead.status, "EMAIL_SENT");
                const nextStatus = stateTransition.nextState;

                const enrolled = await followUpEngine.enrollLead(freshLead, {
                    sentAt: new Date(),
                    subject: result.metadata?.subject,
                    messageId: result.metadata?.messageId,
                    research: result.metadata?.research,
                    mailId: result.metadata?.mailId,
                }).catch(() => null);
                const firstFollowUpAt = enrolled?.tasks?.[0]?.scheduled_at
                    ? new Date(enrolled.tasks[0].scheduled_at)
                    : new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

                await Lead.updateById(
                    freshLead.id,
                    {
                        status: nextStatus,
                        attempt_counters: currentCounters,
                        last_contacted_at: new Date(),
                        next_action: currentCounters.email >= 3 ? null : "EMAIL",
                        next_action_time: currentCounters.email >= 3 ? null : firstFollowUpAt,
                    },
                    orgId
                );

                await eventBus.publish("ActionCompleted", {
                    organization_id: orgId,
                    lead_id: freshLead.id,
                    channel: "EMAIL",
                    action: "EMAIL",
                    status: result.status,
                    metadata: result.metadata || { error: result.error },
                });

                if (stateTransition.changed) {
                    await eventBus.publish("LeadStateChanged", {
                        organization_id: orgId,
                        lead_id: freshLead.id,
                        channel: "EMAIL",
                        from_state: freshLead.status,
                        to_state: nextStatus,
                    });
                }

                const outcome = normalizeChannelOutcome("EMAIL", result.rawResponse);
                const emailedLead = {
                    ...freshLead,
                    status: nextStatus,
                    attempt_counters: currentCounters,
                    last_contacted_at: new Date(),
                };
                await OrchestratorService.handleOutcomeEvent(
                    emailedLead,
                    outcome,
                    {
                        channel: "EMAIL",
                        skipNextActionSchedule: currentCounters.email === 1,
                        ...result.metadata,
                    }
                );

                if (currentCounters.email === 1) {
                    const latest = await Lead.findById(freshLead.id, orgId);
                    await OrchestratorService.schedulePostFirstEmailAction(latest || emailedLead).catch((err) => {
                        console.error("[ASE] Post-first-email call schedule failed:", err.message);
                    });
                }

                await AseExecution.complete(claim.executionId, "SUCCEEDED", result.metadata);
                return { executed: true, action: "EMAIL" };
            } else {
                await AseExecution.complete(claim.executionId, "CANCELLED", { reason: `Unknown action ${action}` });
                return { executed: false, reason: `Unknown action ${action}` };
            }
        } catch (err) {
            console.error(`[ASE Scheduler] Failed executing ${action} on lead ${freshLead.id}:`, err.message);
            await AseExecution.complete(claim.executionId, "FAILED", { error: err.message });
            await eventBus.publish("ActionFailed", {
                organization_id: orgId,
                lead_id: freshLead.id,
                channel: "SYSTEM",
                action,
                error: err.message,
            });
            return { executed: false, reason: err.message };
        }
    }

    async checkOverdueCallbacks() {
        try {
            const rows = await Callback.listOverdue(50);
            for (const cb of rows) {
                if (cb.status === "OPEN" || cb.status === "SCHEDULED" || cb.status === "DUE") {
                    const cbOrg = Number(cb.organization_id || 1);
                    await Callback.updateById(cbOrg, cb.id, {
                        status: "OVERDUE",
                        sla_status: "BREACHED",
                        sla_breached_at: new Date(),
                    });
                    await Lead.updateById(cb.lead_id, { health: "RED" }, cbOrg);
                    await eventBus.publish("CallbackSlaBreached", {
                        organization_id: cbOrg,
                        lead_id: cb.lead_id,
                        channel: "SYSTEM",
                        status: "OVERDUE",
                        callback_id: cb.id,
                        due_at: cb.due_at,
                    });
                }
            }
        } catch (_) { }
    }
}

export const aseScheduler = new AseScheduler();

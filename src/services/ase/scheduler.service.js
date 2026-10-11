import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { AseExecution } from "../../models/ase-execution.model.js";
import { Callback } from "../../models/callback.model.js";
import { emailAdapter } from "./adapters/email.adapter.js";
import { voiceAdapter } from "./adapters/voice.adapter.js";
import { normalizeChannelOutcome } from "./outcomeNormalizer.service.js";
import { OrchestratorService } from "./orchestrator.service.js";
import { validateDispatchEligibility } from "./complianceGate.service.js";

class AseScheduler {
    constructor() {
        this.isRunning = false;
        this.timer = null;
        this.pollIntervalMs = 15000;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log("[ASE Scheduler] Started 24/7 background scheduler heartbeat");
        this.poll();
    }

    stop() {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        console.log("[ASE Scheduler] Stopped scheduler");
    }

    async poll() {
        if (!this.isRunning) return;
        try {
            await this.executeDueActions();
            await this.checkOverdueCallbacks();
        } catch (error) {
            console.error("[ASE Scheduler] Error during cycle:", error.message);
        } finally {
            if (this.isRunning) {
                this.timer = setTimeout(() => this.poll(), this.pollIntervalMs);
            }
        }
    }

    async executeDueActions() {
        const dueLeads = await Lead.findDueForAction(10);
        if (dueLeads.length === 0) return;

        for (const lead of dueLeads) {
            await this.processLeadAction(lead);
        }
    }

    async processLeadAction(lead) {
        const orgId = Number(lead.organization_id || 1);
        const action = lead.next_action;
        const timeStr = lead.next_action_time ? new Date(lead.next_action_time).toISOString() : new Date().toISOString();
        const idempotencyKey = `exec_${orgId}_${lead.id}_${action}_${timeStr}`;

        const claim = await AseExecution.claim({
            organization_id: orgId,
            lead_id: lead.id,
            idempotency_key: idempotencyKey,
            action_type: action,
        });

        if (!claim.claimed) {
            return;
        }

        const eligibility = await validateDispatchEligibility(lead, action);
        if (!eligibility.eligible) {
            await AseExecution.complete(claim.executionId, "CANCELLED", { reason: eligibility.reason });
            await Lead.updateById(
                lead.id,
                { next_action: null, next_action_time: null },
                orgId
            );
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "ACTION_BLOCKED_BY_COMPLIANCE",
                status: "CANCELLED",
                payload: { action, reason: eligibility.reason },
            });
            return;
        }

        try {
            let result;
            let channel;

            if (action === "EMAIL") {
                channel = "EMAIL";
                result = await emailAdapter.execute(lead, "SEND");
            } else if (action === "CALL") {
                channel = "VOICE";
                result = await voiceAdapter.execute(lead, "CALL");
            } else {
                await AseExecution.complete(claim.executionId, "CANCELLED", { reason: `Unknown action ${action}` });
                return;
            }

            const currentCounters = lead.attempt_counters || { email: 0, voice: 0, total: 0 };
            if (channel === "EMAIL") currentCounters.email = (currentCounters.email || 0) + 1;
            if (channel === "VOICE") currentCounters.voice = (currentCounters.voice || 0) + 1;
            currentCounters.total = (currentCounters.total || 0) + 1;

            const nextStatus = lead.status === "NEW" || lead.status === "QUEUED" ? "CONTACTED" : lead.status;

            await Lead.updateById(
                lead.id,
                {
                    status: nextStatus,
                    attempt_counters: currentCounters,
                    last_contacted_at: new Date(),
                    next_action_time: null,
                },
                orgId
            );

            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel,
                event_type: result.status === "SUCCEEDED" ? `${channel}_SENT` : `${channel}_FAILED`,
                status: result.status,
                payload: result.metadata || { error: result.error },
            });

            const outcome = normalizeChannelOutcome(channel, result.rawResponse);
            await OrchestratorService.handleOutcomeEvent(
                { ...lead, status: nextStatus, attempt_counters: currentCounters },
                outcome,
                { channel, ...result.metadata }
            );

            await AseExecution.complete(claim.executionId, "SUCCEEDED", result.metadata);
        } catch (err) {
            console.error(`[ASE Scheduler] Failed executing ${action} on lead ${lead.id}:`, err.message);
            await AseExecution.complete(claim.executionId, "FAILED", { error: err.message });
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "ACTION_FAILED",
                status: "FAILED",
                payload: { action, error: err.message },
            });
        }
    }

    async checkOverdueCallbacks() {
        try {
            const rows = await Callback.list(1, { overdue: true, limit: 50 });
            for (const cb of rows) {
                if (cb.status === "OPEN") {
                    await Callback.updateById(cb.organization_id || 1, cb.id, { status: "OVERDUE" });
                    await Lead.updateById(cb.lead_id, { health: "RED" }, cb.organization_id || 1);
                    await LeadEvent.create({
                        organization_id: cb.organization_id || 1,
                        lead_id: cb.lead_id,
                        channel: "SYSTEM",
                        event_type: "CALLBACK_OVERDUE",
                        status: "OVERDUE",
                        payload: { callbackId: cb.id, dueAt: cb.due_at },
                    });
                }
            }
        } catch (_) {}
    }
}

export const aseScheduler = new AseScheduler();

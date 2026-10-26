import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Callback } from "../../models/callback.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { ASE_OUTCOMES, shouldQueueHumanHandoff } from "./outcomeNormalizer.service.js";
import { transitionLeadState, TERMINAL_STATES } from "./leadStateMachine.js";
import { eventBus } from "./eventBus.service.js";
import { aseDecisionEngine } from "./brain/aseDecisionEngine.service.js";
import { decisionFeedbackService } from "./brain/decisionFeedback.service.js";
import { query } from "../../config/db.js";
import { followUpEngine } from "../followup/followUpEngine.service.js";
import { env } from "../../config/env.js";
import { calculateNextCallingTime } from "./callingHours.service.js";

const MAX_EMAILS = 3;
const MAX_CALLS = 2;

export const OrchestratorService = {
    async evaluateNextAction(lead) {
        if (!lead || TERMINAL_STATES.includes(lead.status) || lead.do_not_contact) {
            return { action: null, reason: "Lead is terminal or DNC" };
        }

        const orgId = Number(lead.organization_id || 1);
        const domain = lead.email ? lead.email.split("@")[1] : null;
        const isSuppressed = await Suppression.isSuppressed(orgId, {
            email: lead.email,
            phone: lead.phone,
            domain,
        });

        if (isSuppressed) {
            const transition = transitionLeadState(lead.status, "SUPPRESS_DNC", {
                reason: isSuppressed.reason || "Suppression match",
            });
            await Lead.updateById(
                lead.id,
                { status: transition.nextState, do_not_contact: 1, next_action: null, next_action_time: null },
                orgId
            );
            await eventBus.publish("LeadSuppressed", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                status: transition.nextState,
                reason: isSuppressed.reason || "Suppression match",
            });
            return { action: null, reason: "Lead matched suppression list" };
        }

        const counters = typeof lead.attempt_counters === "string"
            ? JSON.parse(lead.attempt_counters || "{}")
            : (lead.attempt_counters || { email: 0, voice: 0, total: 0 });

        if (counters.email >= MAX_EMAILS && counters.voice >= MAX_CALLS) {
            const transition = transitionLeadState(lead.status, "NO_RESPONSE", {
                reason: "Max fatigue limits reached across channels",
            });
            await Lead.updateById(
                lead.id,
                { status: transition.nextState, next_action: null, next_action_time: null },
                orgId
            );
            await eventBus.publish("LeadStateChanged", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                from_state: lead.status,
                to_state: transition.nextState,
                reason: "Frequency caps exhausted",
            });
            return { action: null, reason: "Frequency caps exhausted" };
        }

        const brainDecision = await aseDecisionEngine.evaluateLead(lead, { audit: true });

        return {
            action: brainDecision.action || null,
            scheduledTime: brainDecision.scheduledTime || new Date(Date.now() + Number(brainDecision.delayHours || 2) * 3600 * 1000),
            delayHours: Number(brainDecision.delayHours || 0),
            channel: brainDecision.channel,
            priority: brainDecision.priority,
            confidence: brainDecision.confidence,
            explanation: brainDecision.explanation,
            reasonCode: brainDecision.reasonCode,
            isAssistedByMl: brainDecision.isAssistedByMl,
            modelVersion: brainDecision.modelVersion,
            reason: brainDecision.action ? null : (brainDecision.explanation || brainDecision.reasonCode),
        };
    },

    async handleOutcomeEvent(lead, outcome, rawData = {}) {
        const orgId = Number(lead.organization_id || 1);

        await decisionFeedbackService.recordOutcome({
            organizationId: orgId,
            leadId: lead.id,
            channel: rawData.channel || "SYSTEM",
            outcome,
            rawPayload: rawData,
        });

        if (outcome === ASE_OUTCOMES.DNC) {
            const transition = transitionLeadState(lead.status, "SUPPRESS_DNC", { outcome, rawData });
            await Lead.updateById(
                lead.id,
                {
                    status: transition.nextState,
                    do_not_contact: 1,
                    next_action: null,
                    next_action_time: null,
                },
                orgId
            );
            await Suppression.add(orgId, "EMAIL", lead.email, "Prospect requested DNC during outreach");
            if (lead.phone) await Suppression.add(orgId, "PHONE", lead.phone, "Prospect requested DNC during outreach");

            await eventBus.publish("ChannelOutcomeReceived", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: rawData.channel || "VOICE",
                outcome,
                rawData,
            });

            await eventBus.publish("LeadSuppressed", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: rawData.channel || "SYSTEM",
                status: transition.nextState,
                payload: rawData,
            });

            await followUpEngine.handleSuppression(lead.id, orgId).catch(() => {});
            return;
        }

        if (shouldQueueHumanHandoff(outcome, rawData)) {
            const transition = transitionLeadState(
                lead.status,
                outcome === ASE_OUTCOMES.CALLBACK ? "CALLBACK_REQUESTED" : "INTEREST_DETECTED",
                { outcome, rawData }
            );

            let assignedRepId = lead.assigned_rep_id ? Number(lead.assigned_rep_id) : null;
            if (!assignedRepId) {
                try {
                    const reps = await query(
                        `SELECT id FROM users 
                         WHERE organization_id = ?
                         ORDER BY (role = 'SALESPERSON' OR role = 'SALES_MANAGER') DESC, id ASC 
                         LIMIT 1`,
                        [orgId]
                    );
                    if (reps && reps.length > 0) {
                        assignedRepId = reps[0].id;
                    }
                } catch (repErr) {
                    console.warn("[Orchestrator] Could not auto-assign rep:", repErr.message);
                }
            }

            const dueAt = new Date(Date.now() + 30 * 60 * 1000);
            const callId = rawData.callId ? Number(rawData.callId) : (rawData.call_id ? Number(rawData.call_id) : null);
            const callback = await Callback.create({
                organization_id: orgId,
                lead_id: lead.id,
                call_id: callId,
                assigned_rep_id: assignedRepId,
                due_at: dueAt,
                requested_at: new Date(),
                status: "OPEN",
                notes: `Automated handoff: Prospect showed interest / requested callback.`,
            });

            await followUpEngine.handleMeetingBooked(lead.id, orgId).catch(() => {});

            await Lead.updateById(
                lead.id,
                {
                    status: transition.nextState,
                    assigned_rep_id: assignedRepId,
                    callback_due: dueAt,
                    health: "AMBER",
                    next_action: "REP_CALLBACK",
                    next_action_time: null,
                },
                orgId
            );

            await eventBus.publish("ChannelOutcomeReceived", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: rawData.channel || "VOICE",
                outcome,
                rawData,
            });

            await eventBus.publish("CallbackCreated", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                status: transition.nextState,
                callback_id: callback.id,
                due_at: dueAt,
                call_id: callback.call_id,
                rawData,
            });
            return;
        }

        if (outcome === ASE_OUTCOMES.NOT_INTERESTED) {
            const transition = transitionLeadState(lead.status, "NOT_INTERESTED", { outcome, rawData });
            await Lead.updateById(
                lead.id,
                { status: transition.nextState, next_action: null, next_action_time: null },
                orgId
            );

            await eventBus.publish("ChannelOutcomeReceived", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: rawData.channel || "SYSTEM",
                outcome,
                rawData,
            });

            await eventBus.publish("LeadStateChanged", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: rawData.channel || "SYSTEM",
                from_state: lead.status,
                to_state: transition.nextState,
                payload: rawData,
            });
            return;
        }

        if (rawData.skipNextActionSchedule) {
            return;
        }

        const nextDecision = await this.evaluateNextAction(lead);
        if (nextDecision.action) {
            const queueTransition = transitionLeadState(
                lead.status,
                nextDecision.action === "EMAIL" ? "DISPATCH_EMAIL" : "DISPATCH_CALL"
            );

            await Lead.updateById(
                lead.id,
                {
                    status: queueTransition.nextState,
                    next_action: nextDecision.action,
                    next_action_time: nextDecision.scheduledTime,
                },
                orgId
            );

            await eventBus.publish("ActionScheduled", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                action: nextDecision.action,
                scheduled_time: nextDecision.scheduledTime,
            });
        }
    },

    async handleDirectEvent(lead, eventType, payload = {}) {
        const orgId = Number(lead.organization_id || 1);
        const transition = transitionLeadState(lead.status, eventType, payload);

        if (transition.changed) {
            await Lead.updateById(
                lead.id,
                { status: transition.nextState },
                orgId
            );
            await eventBus.publish("LeadStateChanged", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: payload.channel || "SYSTEM",
                from_state: lead.status,
                to_state: transition.nextState,
                payload,
            });
        }

        return transition;
    },

    async handleEmailOpen(lead, data = {}) {
        if (!lead || TERMINAL_STATES.includes(lead.status) || lead.do_not_contact) {
            return { handled: false, callScheduled: false, reason: "Lead is terminal or DNC" };
        }

        if (data.isScanner) {
            return { handled: true, callScheduled: false, reason: "Scanner or privacy-proxy open ignored" };
        }

        const orgId = Number(lead.organization_id || 1);
        const { mailId = null, campaignId = null } = data;

        if (lead.status === "CONTACTED" || lead.status === "NEW" || lead.status === "QUEUED") {
            const transition = transitionLeadState(lead.status, "EMAIL_ENGAGED");
            if (transition.changed) {
                await Lead.updateById(lead.id, { status: transition.nextState }, orgId);
                await eventBus.publish("LeadStateChanged", {
                    organization_id: orgId,
                    lead_id: lead.id,
                    channel: "EMAIL",
                    from_state: lead.status,
                    to_state: transition.nextState,
                    reason: "Lead opened outreach email",
                    mail_id: mailId,
                    campaign_id: campaignId,
                });
                lead.status = transition.nextState;
            }
        }

        return {
            handled: true,
            callScheduled: false,
            reason: "Email open does not dispatch a call; orchestrator times the post-send call",
        };
    },

    async schedulePostFirstEmailAction(lead) {
        if (!lead || TERMINAL_STATES.includes(lead.status) || lead.do_not_contact) {
            return { scheduled: false, reason: "Lead is terminal or DNC" };
        }
        if (lead.next_action === "REP_CALLBACK") {
            return { scheduled: false, reason: "Human callback already queued" };
        }

        const counters = typeof lead.attempt_counters === "string"
            ? JSON.parse(lead.attempt_counters || "{}")
            : (lead.attempt_counters || { email: 0, voice: 0, total: 0 });
        if (Number(counters.email || 0) !== 1) {
            return { scheduled: false, reason: "Only the first outreach email triggers timed call scheduling" };
        }
        if (Number(counters.voice || 0) >= MAX_CALLS) {
            return { scheduled: false, reason: "Maximum voice call limit reached" };
        }
        if (!lead.phone || lead.voice_consent?.status !== "GRANTED") {
            return { scheduled: false, reason: "Call not eligible (phone or voice consent)" };
        }

        const orgId = Number(lead.organization_id || 1);
        const decision = await this.evaluateNextAction(lead);
        const delayHours = Number.isFinite(Number(decision.delayHours))
            ? Math.max(0.25, Number(decision.delayHours))
            : Math.max(0.25, Number(env.callAfterFirstEmailDelayMinutes || 15) / 60);

        let scheduledTime = decision.scheduledTime ? new Date(decision.scheduledTime) : null;
        if (!scheduledTime || Number.isNaN(scheduledTime.getTime()) || scheduledTime.getTime() < Date.now() + 60 * 1000) {
            scheduledTime = calculateNextCallingTime(lead, {
                delaySeconds: Math.round(delayHours * 3600),
                startHour: env.callingHoursStart,
                endHour: env.callingHoursEnd,
                timezone: env.callingTimezone,
            });
        }

        const metadata = typeof lead.metadata === "object" && lead.metadata ? lead.metadata : {};
        await Lead.updateById(
            lead.id,
            {
                next_action: "CALL",
                next_action_time: scheduledTime,
                metadata: {
                    ...metadata,
                    post_first_email_call: "queued",
                    call_delay_hours: delayHours,
                    call_reason: decision.reasonCode || decision.explanation || "ML_TIMING_HEAD",
                },
            },
            orgId
        );

        await eventBus.publish("ActionScheduled", {
            organization_id: orgId,
            lead_id: lead.id,
            channel: "VOICE",
            action: "CALL",
            scheduled_time: scheduledTime,
            delay_hours: delayHours,
            trigger: "FIRST_EMAIL_SENT",
            reason_code: decision.reasonCode,
            is_assisted_by_ml: Boolean(decision.isAssistedByMl),
        });

        return {
            scheduled: true,
            action: "CALL",
            scheduledTime,
            delayHours,
            isAssistedByMl: Boolean(decision.isAssistedByMl),
        };
    },
};

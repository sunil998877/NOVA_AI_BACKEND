import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Callback } from "../../models/callback.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { ASE_OUTCOMES } from "./outcomeNormalizer.service.js";
import { transitionLeadState, TERMINAL_STATES } from "./leadStateMachine.js";
import { eventBus } from "./eventBus.service.js";
import { aseDecisionEngine } from "./brain/aseDecisionEngine.service.js";
import { decisionFeedbackService } from "./brain/decisionFeedback.service.js";
import { query } from "../../config/db.js";
import { followUpEngine } from "../followup/followUpEngine.service.js";
import { env } from "../../config/env.js";
import { Campaign } from "../../models/campaign.model.js";
import { calculateNextCallingTime } from "./callingHours.service.js";
import { aseScheduler } from "./scheduler.service.js";

const MAX_EMAILS = 3;
const MAX_CALLS = 2;
const MIN_TOUCH_GAP_HOURS = Number(process.env.ASE_MIN_TOUCH_GAP_HOURS || 2);

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

        if (!brainDecision.action) {
            return { action: null, reason: brainDecision.explanation || brainDecision.reasonCode };
        }

        return {
            action: brainDecision.action,
            scheduledTime: brainDecision.scheduledTime || new Date(),
            channel: brainDecision.channel,
            priority: brainDecision.priority,
            confidence: brainDecision.confidence,
            explanation: brainDecision.explanation,
            reasonCode: brainDecision.reasonCode,
            isAssistedByMl: brainDecision.isAssistedByMl,
            modelVersion: brainDecision.modelVersion,
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

        if (outcome === ASE_OUTCOMES.INTERESTED || outcome === ASE_OUTCOMES.CALLBACK) {
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
                         WHERE (organization_id = ? OR organization_id IS NULL)
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

            if (outcome === ASE_OUTCOMES.CALLBACK) {
                await followUpEngine.handleMeetingBooked(lead.id, orgId).catch(() => {});
            }

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
            return { handled: false, reason: "Lead is terminal or DNC" };
        }

        const orgId = Number(lead.organization_id || 1);
        const {
            mailId = null,
            campaignId = null,
            isScanner = false,
            scannerType = null,
            userAgent = null,
            ipAddress = null,
        } = data;

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

        if (env.autoCallOnEmailOpen === false) {
            return { handled: true, callScheduled: false, reason: "Auto-call on email open disabled" };
        }

        const privacyProxy = ["GOOGLE_IMAGE_PROXY", "APPLE_PRIVACY_PROXY", "YAHOO_PROXY"].includes(scannerType);
        if (isScanner && !privacyProxy && !env.allowBotOpenCall && !env.bypassTimingGates) {
            return { handled: true, callScheduled: false, reason: `Suppressed scanner open: ${scannerType}` };
        }

        if (lead.next_action === "CALL") {
            try {
                aseScheduler.kick();
                await aseScheduler.processLeadAction(lead);
            } catch (_) {}
            return { handled: true, callScheduled: true, reason: "Call already queued" };
        }

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
            return { handled: true, callScheduled: false, reason: "Suppression match" };
        }

        if (!lead.phone) {
            return { handled: true, callScheduled: false, reason: "Lead has no phone number" };
        }

        if (lead.voice_consent?.status !== "GRANTED") {
            return { handled: true, callScheduled: false, reason: "Voice consent not granted" };
        }

        if (campaignId) {
            try {
                const camp = await Campaign.findById(campaignId);
                if (camp && (camp.camp_status === "Paused" || camp.status === "paused" || camp.status === "cancelled")) {
                    return { handled: true, callScheduled: false, reason: "Campaign is paused or cancelled" };
                }
            } catch (_) {}
        }

        const counters = typeof lead.attempt_counters === "string"
            ? JSON.parse(lead.attempt_counters || "{}")
            : (lead.attempt_counters || { email: 0, voice: 0, total: 0 });

        if (Number(counters.voice || 0) >= MAX_CALLS) {
            return { handled: true, callScheduled: false, reason: "Maximum voice call limit reached" };
        }

        const stepKey = mailId ? `mail_${mailId}` : (campaignId ? `camp_${campaignId}` : "open");
        const existingCalls = await query(
            `SELECT id, provider_status, normalized_outcome, created_at FROM calls 
             WHERE organization_id = ? AND lead_id = ? AND idempotency_key LIKE ? 
             ORDER BY id DESC LIMIT 1`,
            [orgId, lead.id, `%${stepKey}%`]
        );

        if (existingCalls && existingCalls.length > 0) {
            return { handled: true, callScheduled: false, reason: "Call already scheduled or executed for this step" };
        }

        if (env.autoCallReviewMode && !env.bypassTimingGates) {
            await Lead.updateById(
                lead.id,
                { next_action: "CALL_PENDING_REVIEW", next_action_time: null },
                orgId
            );
            await eventBus.publish("ActionScheduled", {
                organization_id: orgId,
                lead_id: lead.id,
                channel: "VOICE",
                action: "CALL_PENDING_REVIEW",
                review_mode: true,
                mail_id: mailId,
            });
            return { handled: true, callScheduled: false, reviewMode: true };
        }

        const delaySeconds = Number.isFinite(env.autoCallDelaySeconds) ? Math.max(0, env.autoCallDelaySeconds) : 30;
        const scheduledTime = calculateNextCallingTime(lead, {
            delaySeconds,
            startHour: env.callingHoursStart,
            endHour: env.callingHoursEnd,
            timezone: env.callingTimezone,
        });

        const updated = await Lead.updateById(
            lead.id,
            {
                next_action: "CALL",
                next_action_time: scheduledTime,
                metadata: {
                    ...(typeof lead.metadata === "object" && lead.metadata ? lead.metadata : {}),
                    email_opened_at: new Date().toISOString(),
                    auto_call_on_open: "queued",
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
            trigger: "EMAIL_OPENED",
            mail_id: mailId,
            campaign_id: campaignId,
        });

        try {
            aseScheduler.kick();
            if (scheduledTime.getTime() <= Date.now() + 1000) {
                await aseScheduler.processLeadAction(updated || { ...lead, next_action: "CALL", next_action_time: scheduledTime });
            }
        } catch (err) {
            console.error("[ASE] Auto-call after email open failed:", err.message);
        }

        return {
            handled: true,
            callScheduled: true,
            scheduledTime,
        };
    },
};

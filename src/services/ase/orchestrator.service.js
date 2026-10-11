import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Callback } from "../../models/callback.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { ASE_OUTCOMES } from "./outcomeNormalizer.service.js";

const TERMINAL_STATES = new Set([
    "CLOSED_WON",
    "CLOSED_LOST",
    "CLOSED_UNQUALIFIED",
    "SUPPRESSED_DNC",
]);

const MAX_EMAILS = 3;
const MAX_CALLS = 2;
const MIN_TOUCH_GAP_HOURS = 24;

export const OrchestratorService = {
    async evaluateNextAction(lead) {
        if (!lead || TERMINAL_STATES.has(lead.status) || lead.do_not_contact) {
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
            await Lead.updateById(
                lead.id,
                { status: "SUPPRESSED_DNC", do_not_contact: 1, next_action: null, next_action_time: null },
                orgId
            );
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "LEAD_SUPPRESSED",
                status: "SUPPRESSED_DNC",
                payload: { reason: isSuppressed.reason || "Suppression match" },
            });
            return { action: null, reason: "Lead matched suppression list" };
        }

        const counters = lead.attempt_counters || { email: 0, voice: 0, total: 0 };
        const emailAllowed = lead.email_consent?.status !== "DENIED" && Boolean(lead.email);
        const voiceAllowed = lead.voice_consent?.status !== "DENIED" && Boolean(lead.phone);

        if (counters.email >= MAX_EMAILS && counters.voice >= MAX_CALLS) {
            await Lead.updateById(
                lead.id,
                { status: "NO_RESPONSE", next_action: null, next_action_time: null },
                orgId
            );
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "LEAD_STATE_CHANGED",
                status: "NO_RESPONSE",
                payload: { reason: "Max fatigue limits reached across channels" },
            });
            return { action: null, reason: "Frequency caps exhausted" };
        }

        let nextAction = null;
        let delayHours = MIN_TOUCH_GAP_HOURS;

        if (lead.status === "NEW" || lead.status === "QUEUED") {
            if (emailAllowed && counters.email === 0) {
                nextAction = "EMAIL";
                delayHours = 0;
            } else if (voiceAllowed && counters.voice === 0) {
                nextAction = "CALL";
                delayHours = 0;
            }
        } else if (lead.status === "CONTACTED" || lead.status === "ENGAGED") {
            if (counters.voice < MAX_CALLS && voiceAllowed && counters.email > counters.voice) {
                nextAction = "CALL";
                delayHours = 24;
            } else if (counters.email < MAX_EMAILS && emailAllowed) {
                nextAction = "EMAIL";
                delayHours = 48;
            }
        }

        if (!nextAction) {
            return { action: null, reason: "No eligible channel remaining under rules" };
        }

        const scheduledTime = new Date(Date.now() + delayHours * 3600 * 1000);
        return {
            action: nextAction,
            scheduledTime,
            channel: nextAction === "EMAIL" ? "EMAIL" : "VOICE",
        };
    },

    async handleOutcomeEvent(lead, outcome, rawData = {}) {
        const orgId = Number(lead.organization_id || 1);

        if (outcome === ASE_OUTCOMES.DNC) {
            await Lead.updateById(
                lead.id,
                {
                    status: "SUPPRESSED_DNC",
                    do_not_contact: 1,
                    next_action: null,
                    next_action_time: null,
                },
                orgId
            );
            await Suppression.add(orgId, "EMAIL", lead.email, "Prospect requested DNC during outreach");
            if (lead.phone) await Suppression.add(orgId, "PHONE", lead.phone, "Prospect requested DNC during outreach");

            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: rawData.channel || "SYSTEM",
                event_type: "OUTCOME_DNC",
                status: "SUPPRESSED_DNC",
                payload: rawData,
            });
            return;
        }

        if (outcome === ASE_OUTCOMES.INTERESTED || outcome === ASE_OUTCOMES.CALLBACK) {
            const dueAt = new Date(Date.now() + 30 * 60 * 1000);
            const callback = await Callback.create({
                organization_id: orgId,
                lead_id: lead.id,
                assigned_rep_id: lead.assigned_rep_id,
                due_at: dueAt,
                status: "OPEN",
                notes: `Automated handoff: Prospect showed interest / requested callback.`,
            });

            await Lead.updateById(
                lead.id,
                {
                    status: "CALLBACK_SCHEDULED",
                    callback_due: dueAt,
                    health: "AMBER",
                    next_action: "REP_CALLBACK",
                    next_action_time: null,
                },
                orgId
            );

            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: rawData.channel || "SYSTEM",
                event_type: outcome === ASE_OUTCOMES.CALLBACK ? "CALLBACK_CREATED" : "OUTCOME_INTERESTED",
                status: "CALLBACK_SCHEDULED",
                payload: { callbackId: callback.id, dueAt, rawData },
            });
            return;
        }

        if (outcome === ASE_OUTCOMES.NOT_INTERESTED) {
            await Lead.updateById(
                lead.id,
                { status: "NOT_INTERESTED", next_action: null, next_action_time: null },
                orgId
            );
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: rawData.channel || "SYSTEM",
                event_type: "OUTCOME_NOT_INTERESTED",
                status: "NOT_INTERESTED",
                payload: rawData,
            });
            return;
        }

        const nextDecision = await this.evaluateNextAction(lead);
        if (nextDecision.action) {
            await Lead.updateById(
                lead.id,
                {
                    next_action: nextDecision.action,
                    next_action_time: nextDecision.scheduledTime,
                },
                orgId
            );
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "ORCHESTRATOR_DECISION",
                status: "SCHEDULED",
                payload: { nextAction: nextDecision.action, at: nextDecision.scheduledTime },
            });
        }
    },
};

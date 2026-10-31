import { Suppression } from "../../models/suppression.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { FollowUpEnrollment } from "../../models/follow-up-enrollment.model.js";
import { isWithinCallingHours } from "./callingHours.service.js";
import { minTouchGapHours } from "./brain/featureSchema.js";
import { consentBlockReason } from "./consent.service.js";
import { haltOutreachForLead } from "./outreachHalt.service.js";
import { MAX_CALLS, MAX_EMAILS, TERMINAL_STATES as TERMINAL_LIST } from "./lifecycle.constants.js";
import { isOutreachStopped } from "./lifecycle.service.js";

const TERMINAL_STATES = new Set(TERMINAL_LIST);

export async function validateDispatchEligibility(lead, action, options = {}) {
    if (!lead) {
        return { eligible: false, reason: "Lead record not found" };
    }

    if (isOutreachStopped(lead) || lead.do_not_contact) {
        const reason = lead.do_not_contact
            ? "Lead marked do_not_contact"
            : `Lead is in terminal state ${lead.status}`;
        return { eligible: false, reason };
    }

    if (TERMINAL_STATES.has(lead.status)) {
        return { eligible: false, reason: `Lead is in terminal state ${lead.status}` };
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
            payload: { reason: isSuppressed.reason || "Suppression match during pre-dispatch gate" },
        });
        await haltOutreachForLead(orgId, lead.id, "Lead matched suppression list").catch(() => {});
        return { eligible: false, reason: "Lead matched suppression list" };
    }

    if (lead.last_contacted_at && !options.isEngagementTrigger && lead.status !== "ENGAGED" && !options.bypassCooldown) {
        const minGapHours = minTouchGapHours();
        const msSinceLast = Date.now() - new Date(lead.last_contacted_at).getTime();
        if (msSinceLast < minGapHours * 3600 * 1000) {
            return { eligible: false, reason: "Same-day outreach cooldown active" };
        }
    }

    const cadence = Boolean(options.cadence);
    if (!cadence) {
        const activeEnrollment = await FollowUpEnrollment.findActiveByLeadId(lead.id, orgId);
        if (activeEnrollment && !options.isEngagementTrigger && lead.status !== "ENGAGED") {
            return { eligible: false, reason: "Lead is actively enrolled in follow-up sequence cadence" };
        }
    }

    const counters = typeof lead.attempt_counters === "string"
        ? JSON.parse(lead.attempt_counters || "{}")
        : (lead.attempt_counters || { email: 0, voice: 0, total: 0 });

    if (action === "EMAIL") {
        if (!lead.email) {
            return { eligible: false, reason: "Lead has no email address" };
        }
        const consentReason = consentBlockReason(lead, "EMAIL");
        if (consentReason) {
            await logComplianceBlock(orgId, lead.id, "EMAIL", consentReason);
            return { eligible: false, reason: consentReason };
        }
        if (!cadence && Number(counters.email || 0) >= MAX_EMAILS) {
            return { eligible: false, reason: "Maximum email fatigue limit reached" };
        }
    }

    if (action === "CALL") {
        if (!lead.phone) {
            return { eligible: false, reason: "Lead has no phone number" };
        }
        const cleanedDigits = String(lead.phone).replace(/[^\d]/g, "");
        if (cleanedDigits.length < 10 || cleanedDigits.length > 15) {
            return { eligible: false, reason: "Lead phone number is unverified or invalid" };
        }
        const consentReason = consentBlockReason(lead, "CALL");
        if (consentReason) {
            await logComplianceBlock(orgId, lead.id, "VOICE", consentReason);
            return { eligible: false, reason: consentReason };
        }
        if (!cadence && Number(counters.voice || 0) >= MAX_CALLS) {
            return { eligible: false, reason: "Maximum call fatigue limit reached" };
        }
        if (!cadence && !options.bypassCallingHours && !isWithinCallingHours(lead, options)) {
            return { eligible: false, reason: "Outside allowed calling hours" };
        }
    }

    return { eligible: true };
}

async function logComplianceBlock(orgId, leadId, channel, reason) {
    await LeadEvent.create({
        organization_id: orgId,
        lead_id: leadId,
        channel,
        event_type: "ACTION_BLOCKED_BY_COMPLIANCE",
        status: "BLOCKED",
        payload: { reason, channel },
        idempotency_key: `blocked_compliance_${orgId}_${leadId}_${channel}_${String(reason).slice(0, 48)}`,
    }).catch(() => {});
}

export const ComplianceGateService = {
    validateDispatchEligibility,
    TERMINAL_STATES,
    MAX_EMAILS,
    MAX_CALLS,
};

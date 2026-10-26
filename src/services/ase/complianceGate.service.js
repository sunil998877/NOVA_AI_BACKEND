import { Suppression } from "../../models/suppression.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { FollowUpEnrollment } from "../../models/follow-up-enrollment.model.js";
import { isWithinCallingHours } from "./callingHours.service.js";
import { minTouchGapHours } from "./brain/featureSchema.js";

const TERMINAL_STATES = new Set([
    "CLOSED_WON",
    "CLOSED_LOST",
    "CLOSED_UNQUALIFIED",
    "SUPPRESSED_DNC",
]);

const MAX_EMAILS = 3;
const MAX_CALLS = 2;

export async function validateDispatchEligibility(lead, action, options = {}) {
    if (!lead) {
        return { eligible: false, reason: "Lead record not found" };
    }

    if (lead.do_not_contact) {
        return { eligible: false, reason: "Lead marked do_not_contact" };
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
        return { eligible: false, reason: "Lead matched suppression list" };
    }

    if (lead.last_contacted_at && !options.isEngagementTrigger && lead.status !== "ENGAGED" && !options.bypassCooldown) {
        const minGapHours = minTouchGapHours();
        const msSinceLast = Date.now() - new Date(lead.last_contacted_at).getTime();
        if (msSinceLast < minGapHours * 3600 * 1000) {
            return { eligible: false, reason: "Same-day outreach cooldown active" };
        }
    }

    const activeEnrollment = await FollowUpEnrollment.findActiveByLeadId(lead.id, orgId);
    if (activeEnrollment && !options.isEngagementTrigger && lead.status !== "ENGAGED") {
        return { eligible: false, reason: "Lead is actively enrolled in follow-up sequence cadence" };
    }

    const counters = typeof lead.attempt_counters === "string"
        ? JSON.parse(lead.attempt_counters || "{}")
        : (lead.attempt_counters || { email: 0, voice: 0, total: 0 });

    if (action === "EMAIL") {
        if (!lead.email) {
            return { eligible: false, reason: "Lead has no email address" };
        }
        if (lead.email_consent?.status === "DENIED") {
            return { eligible: false, reason: "Email consent has been denied" };
        }
        if (Number(counters.email || 0) >= MAX_EMAILS) {
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
        if (lead.voice_consent?.status === "DENIED") {
            return { eligible: false, reason: "Voice consent has been denied" };
        }
        if (lead.voice_consent?.status !== "GRANTED") {
            return { eligible: false, reason: "Voice consent has not been granted" };
        }
        if (Number(counters.voice || 0) >= MAX_CALLS) {
            return { eligible: false, reason: "Maximum call fatigue limit reached" };
        }
        if (!options.bypassCallingHours && !isWithinCallingHours(lead, options)) {
            return { eligible: false, reason: "Outside allowed calling hours" };
        }
    }

    return { eligible: true };
}

export const ComplianceGateService = {
    validateDispatchEligibility,
    TERMINAL_STATES,
    MAX_EMAILS,
    MAX_CALLS,
};

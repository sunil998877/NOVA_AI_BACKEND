import { Suppression } from "../../models/suppression.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";

const TERMINAL_STATES = new Set([
    "CLOSED_WON",
    "CLOSED_LOST",
    "CLOSED_UNQUALIFIED",
    "SUPPRESSED_DNC",
]);

const MAX_EMAILS = 3;
const MAX_CALLS = 2;

export async function validateDispatchEligibility(lead, action) {
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

    const counters = lead.attempt_counters || { email: 0, voice: 0, total: 0 };

    if (action === "EMAIL") {
        if (!lead.email) {
            return { eligible: false, reason: "Lead has no email address" };
        }
        if (lead.email_consent?.status === "DENIED") {
            return { eligible: false, reason: "Email consent denied" };
        }
        if (Number(counters.email || 0) >= MAX_EMAILS) {
            return { eligible: false, reason: "Maximum email fatigue limit reached" };
        }
    }

    if (action === "CALL") {
        if (!lead.phone) {
            return { eligible: false, reason: "Lead has no phone number" };
        }
        if (lead.voice_consent?.status === "DENIED") {
            return { eligible: false, reason: "Voice consent denied" };
        }
        if (Number(counters.voice || 0) >= MAX_CALLS) {
            return { eligible: false, reason: "Maximum call fatigue limit reached" };
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

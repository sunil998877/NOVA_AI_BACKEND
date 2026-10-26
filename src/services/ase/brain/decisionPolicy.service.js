import { Suppression } from "../../../models/suppression.model.js";
import { FollowUpEnrollment } from "../../../models/follow-up-enrollment.model.js";
import { minTouchGapHours } from "./featureSchema.js";

const TERMINAL_STATES = new Set([
    "CLOSED_WON",
    "CLOSED_LOST",
    "CLOSED_UNQUALIFIED",
    "SUPPRESSED_DNC",
]);

const MAX_EMAILS = 3;
const MAX_CALLS = 2;

export const decisionPolicyService = {
    async evaluateEligibility(lead, features) {
        const orgId = Number(lead.organization_id || 1);
        const blockedReasons = [];

        if (!lead || !lead.id) {
            return {
                isEligible: false,
                terminal: true,
                candidateActions: [],
                blockedReasons: ["LEAD_NOT_FOUND"],
            };
        }

        if (TERMINAL_STATES.has(lead.status)) {
            return {
                isEligible: false,
                terminal: true,
                candidateActions: [],
                blockedReasons: [`TERMINAL_STATE_${lead.status}`],
            };
        }

        if (lead.do_not_contact) {
            return {
                isEligible: false,
                terminal: true,
                candidateActions: [],
                blockedReasons: ["DNC_FLAGGED"],
            };
        }

        const emailAttempts = Number(features?.emailAttempts || lead.attempt_counters?.email || 0);
        const activeEnrollment = await FollowUpEnrollment.findActiveByLeadId(lead.id, orgId);
        if (activeEnrollment && emailAttempts > 0) {
            return {
                isEligible: false,
                cooldownRequired: true,
                terminal: false,
                candidateActions: [],
                blockedReasons: ["FOLLOW_UP_CADENCE_ACTIVE"],
            };
        }

        const domain = lead.email ? lead.email.split("@")[1] : null;
        const isSuppressed = await Suppression.isSuppressed(orgId, {
            email: lead.email,
            phone: lead.phone,
            domain,
        });

        if (isSuppressed) {
            return {
                isEligible: false,
                terminal: true,
                candidateActions: [],
                blockedReasons: ["SUPPRESSION_LIST_MATCH"],
            };
        }

        const candidateActions = [];
        const hoursSinceTouch = Number(features.hoursSinceLastTouch != null ? features.hoursSinceLastTouch : 999);
        const touchCooldown = hoursSinceTouch < minTouchGapHours() && (features.emailAttempts > 0 || features.voiceAttempts > 0);

        if (features.emailAttempts >= MAX_EMAILS) {
            blockedReasons.push("EMAIL_FATIGUE_LIMIT_REACHED");
        } else if (touchCooldown && features.emailAttempts > 0 && features.linkClicks === 0) {
            blockedReasons.push("TOUCH_GAP_COOLDOWN_ACTIVE");
        } else if (!lead.email) {
            blockedReasons.push("MISSING_EMAIL_ADDRESS");
        } else if (lead.email_consent?.status === "DENIED") {
            blockedReasons.push("EMAIL_CONSENT_DENIED");
        } else {
            candidateActions.push("EMAIL");
        }

        if (features.voiceAttempts >= MAX_CALLS) {
            blockedReasons.push("VOICE_FATIGUE_LIMIT_REACHED");
        } else if (touchCooldown && features.voiceAttempts > 0 && features.linkClicks === 0) {
            blockedReasons.push("TOUCH_GAP_COOLDOWN_ACTIVE");
        } else if (!lead.phone) {
            blockedReasons.push("MISSING_PHONE_NUMBER");
        } else if (lead.voice_consent?.status === "DENIED") {
            blockedReasons.push("VOICE_CONSENT_DENIED", "VOICE_CONSENT_NOT_GRANTED");
        } else if (lead.voice_consent?.status !== "GRANTED") {
            blockedReasons.push("VOICE_CONSENT_NOT_GRANTED");
        } else {
            candidateActions.push("CALL");
        }

        return {
            isEligible: candidateActions.length > 0,
            cooldownRequired: touchCooldown,
            terminal: false,
            candidateActions,
            blockedReasons,
        };
    },
};

import { Suppression } from "../../../models/suppression.model.js";
import { FollowUpEnrollment } from "../../../models/follow-up-enrollment.model.js";
import { minTouchGapHours } from "./featureSchema.js";
import { isConsentGranted } from "../consent.service.js";
import { MAX_CALLS, MAX_EMAILS, TERMINAL_STATES as TERMINAL_LIST } from "../lifecycle.constants.js";
import { isOutreachStopped } from "../lifecycle.service.js";

const TERMINAL_STATES = new Set(TERMINAL_LIST);

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

        if (isOutreachStopped(lead) || TERMINAL_STATES.has(lead.status) || lead.do_not_contact) {
            return {
                isEligible: false,
                terminal: true,
                candidateActions: [],
                blockedReasons: lead.do_not_contact ? ["DNC_FLAGGED"] : [`TERMINAL_STATE_${lead.status}`],
            };
        }

        const emailAttempts = Number(features?.emailAttempts || lead.attempt_counters?.email || 0);
        const activeEnrollment = await FollowUpEnrollment.findActiveByLeadId(lead.id, orgId);
        const cadenceActive = Boolean(activeEnrollment && emailAttempts > 0);

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
        } else if (cadenceActive) {
            blockedReasons.push("FOLLOW_UP_CADENCE_ACTIVE");
        } else if (touchCooldown && features.emailAttempts > 0 && features.linkClicks === 0) {
            blockedReasons.push("TOUCH_GAP_COOLDOWN_ACTIVE");
        } else if (!lead.email) {
            blockedReasons.push("MISSING_EMAIL_ADDRESS");
        } else if (lead.email_consent?.status === "DENIED") {
            blockedReasons.push("EMAIL_CONSENT_DENIED");
        } else if (!isConsentGranted(lead.email_consent)) {
            blockedReasons.push("EMAIL_CONSENT_NOT_GRANTED");
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

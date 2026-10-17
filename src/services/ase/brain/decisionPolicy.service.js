import { Suppression } from "../../../models/suppression.model.js";

const TERMINAL_STATES = new Set([
    "CLOSED_WON",
    "CLOSED_LOST",
    "CLOSED_UNQUALIFIED",
    "SUPPRESSED_DNC",
]);

const MAX_EMAILS = 3;
const MAX_CALLS = 2;
const MIN_TOUCH_GAP_HOURS = Number(process.env.ASE_MIN_TOUCH_GAP_HOURS || 2);

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

        if (features.emailAttempts >= MAX_EMAILS) {
            blockedReasons.push("EMAIL_FATIGUE_LIMIT_REACHED");
        } else if (!lead.email) {
            blockedReasons.push("MISSING_EMAIL_ADDRESS");
        } else if (lead.email_consent?.status === "DENIED") {
            blockedReasons.push("EMAIL_CONSENT_DENIED");
        } else {
            candidateActions.push("EMAIL");
        }

        if (features.voiceAttempts >= MAX_CALLS) {
            blockedReasons.push("VOICE_FATIGUE_LIMIT_REACHED");
        } else if (!lead.phone) {
            blockedReasons.push("MISSING_PHONE_NUMBER");
        } else if (lead.voice_consent?.status === "DENIED") {
            blockedReasons.push("VOICE_CONSENT_DENIED");
        } else {
            candidateActions.push("CALL");
        }

        let cooldownRequired = false;
        if (features.emailAttempts > 0 || features.voiceAttempts > 0) {
            if (features.hoursSinceLastTouch < MIN_TOUCH_GAP_HOURS && features.linkClicks === 0) {
                cooldownRequired = true;
                blockedReasons.push("TOUCH_GAP_COOLDOWN_ACTIVE");
            }
        }

        return {
            isEligible: candidateActions.length > 0,
            cooldownRequired,
            terminal: false,
            candidateActions,
            blockedReasons,
        };
    },
};

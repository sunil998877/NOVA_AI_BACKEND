export const decisionExplanationService = {
    generateExplanation({ lead, eligibility, features, priority, decision, prediction }) {
        const reasons = [];

        if (eligibility.terminal) {
            reasons.push(`Lead is in terminal state or marked DNC (${eligibility.blockedReasons.join(", ")})`);
        } else if (decision.recommendedAction === null) {
            reasons.push(decision.reasonCode === "COOLDOWN_ACTIVE"
                ? `Outreach held for touch-gap cooldown (${features.hoursSinceLastTouch} hours elapsed)`
                : `No eligible outreach channels remaining`);
        } else {
            if (decision.isAssistedByMl) {
                reasons.push(`Selected ${decision.recommendedAction} based on ML model recommendation (confidence: ${Math.round(decision.confidence * 100)}%)`);
            } else {
                reasons.push(`Selected ${decision.recommendedAction} via deterministic business rules baseline`);
            }

            if (priority.tier === "P1_URGENT") {
                reasons.push(`Urgent priority applied: ${priority.reason}`);
            }

            if (features.emailAttempts === 0 && decision.recommendedAction === "EMAIL") {
                reasons.push(`Initial introductory outreach for new lead`);
            }
        }

        return {
            summary: reasons.join(". "),
            reasonCodes: [
                decision.reasonCode,
                ...eligibility.blockedReasons,
                priority.tier,
            ],
            eligibilitySummary: {
                candidates: eligibility.candidateActions,
                blocked: eligibility.blockedReasons,
            },
            supportingMetrics: {
                priorityScore: priority.score,
                engagementScore: features.engagementScore,
                emailAttempts: features.emailAttempts,
                voiceAttempts: features.voiceAttempts,
                hoursSinceLastTouch: features.hoursSinceLastTouch,
            },
        };
    },
};

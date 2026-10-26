export const leadPriorityService = {
    calculatePriority(lead, features) {
        let basePriority = Number(lead.priority || 50);

        if (lead.callback_due) {
            const dueMs = new Date(lead.callback_due).getTime();
            const now = Date.now();
            if (dueMs <= now) {
                return {
                    score: 100,
                    tier: "P1_URGENT",
                    reason: "Overdue callback obligation",
                };
            }
            if (dueMs - now <= 2 * 3600 * 1000) {
                return {
                    score: 95,
                    tier: "P1_URGENT",
                    reason: "Upcoming callback within 2 hours",
                };
            }
        }

        if (features.linkClicks > 0 && features.hoursSinceLastTouch <= 2) {
            return {
                score: Math.min(99, basePriority + 40),
                tier: "P1_URGENT",
                reason: "Recent high-intent link interaction",
            };
        }

        if (features.emailOpens >= 2) {
            basePriority += 20;
        }

        if (features.status === "ENGAGED") {
            basePriority += 25;
        }

        if (features.emailAttempts >= 2 && features.linkClicks === 0 && features.emailOpens === 0) {
            basePriority -= 15;
        }

        const score = Math.max(1, Math.min(99, Math.round(basePriority)));
        let tier = "P3_NORMAL";
        if (score >= 90) tier = "P1_URGENT";
        else if (score >= 80) tier = "P2_HIGH";
        else if (score < 40) tier = "P4_LOW";

        return {
            score,
            tier,
            reason: "Computed from lifecycle state and verified engagement",
        };
    },
};

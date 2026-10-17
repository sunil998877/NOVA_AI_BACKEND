import { modelRegistry } from "./modelRegistry.service.js";

export const nextBestActionService = {
    determineNextBestAction({ eligibility, features, priority, prediction }) {
        const { candidateActions, cooldownRequired } = eligibility;
        const status = modelRegistry.getModelStatus();

        const minTouchGap = Number(process.env.ASE_MIN_TOUCH_GAP_HOURS || 2);

        if (candidateActions.length === 0) {
            return {
                recommendedAction: null,
                delayHours: minTouchGap,
                channel: null,
                isAssistedByMl: false,
                reasonCode: cooldownRequired ? "COOLDOWN_ACTIVE" : "NO_ELIGIBLE_CHANNELS",
                shadowPrediction: prediction?.available ? prediction : null,
            };
        }

        let baselineAction = candidateActions.includes("EMAIL") && features.emailAttempts === 0 
            ? "EMAIL" 
            : candidateActions[0];

        if (features.voiceAttempts < 2 && features.voiceConsentAllowed && features.emailAttempts > features.voiceAttempts) {
            if (candidateActions.includes("CALL")) baselineAction = "CALL";
        }

        let finalAction = baselineAction;
        let isAssistedByMl = false;
        let shadowPrediction = null;

        if (prediction?.available) {
            if (status.mode === "ACTIVE") {
                if (prediction.action !== "WAIT" && candidateActions.includes(prediction.action)) {
                    finalAction = prediction.action;
                    isAssistedByMl = true;
                } else if (prediction.action === "WAIT") {
                    if (features.emailAttempts === 0 && features.voiceAttempts === 0) {
                        finalAction = baselineAction;
                        isAssistedByMl = false;
                    } else {
                        finalAction = null;
                        isAssistedByMl = true;
                    }
                }
            } else if (status.mode === "SHADOW") {
                shadowPrediction = {
                    action: prediction.action,
                    confidence: prediction.confidence,
                    modelVersion: prediction.modelVersion,
                    concursWithBaseline: prediction.action === baselineAction,
                };
            }
        }

        let delayHours = 0;
        if (finalAction === null) {
            delayHours = minTouchGap;
        } else if (finalAction === "CALL") {
            delayHours = features.linkClicks > 0 ? 0 : (features.hoursSinceLastTouch < minTouchGap ? Math.max(0, minTouchGap - features.hoursSinceLastTouch) : 0);
        } else if (finalAction === "EMAIL") {
            if (features.emailAttempts === 0) {
                delayHours = 0;
            } else {
                delayHours = features.hoursSinceLastTouch < minTouchGap ? Math.max(0, minTouchGap - features.hoursSinceLastTouch) : 0;
            }
        }

        return {
            recommendedAction: finalAction,
            delayHours,
            channel: finalAction === "EMAIL" ? "EMAIL" : (finalAction === "CALL" ? "VOICE" : null),
            isAssistedByMl,
            shadowPrediction,
            confidence: isAssistedByMl ? prediction.confidence : 1.0,
            reasonCode: isAssistedByMl ? "ML_POLICY_OPTIMIZATION" : "DETERMINISTIC_RULES_BASELINE",
        };
    },
};

import { modelRegistry } from "./modelRegistry.service.js";
import { minTouchGapHours } from "./featureSchema.js";

export const nextBestActionService = {
    determineNextBestAction({ eligibility, features, priority, prediction }) {
        const { candidateActions, cooldownRequired } = eligibility;
        const status = modelRegistry.getModelStatus();
        const minTouchGap = minTouchGapHours();
        const predictedAction = prediction?.action === null || prediction?.action === undefined
            ? "WAIT"
            : String(prediction.action).toUpperCase();

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

        const emailAttempts = Number(features.emailAttempts || 0);
        const voiceAttempts = Number(features.voiceAttempts || 0);
        const untouched = emailAttempts === 0 && voiceAttempts === 0;
        const canCallFirst = candidateActions.includes("CALL") && features.voiceConsentAllowed;

        // Cadence policy: first touch is a call when the lead can be dialed. Email waits for a miss.
        let baselineAction = untouched && canCallFirst
            ? "CALL"
            : (candidateActions.includes("EMAIL") && emailAttempts === 0 ? "EMAIL" : candidateActions[0]);

        if (voiceAttempts < 2 && features.voiceConsentAllowed && emailAttempts > voiceAttempts) {
            if (candidateActions.includes("CALL")) baselineAction = "CALL";
        }

        if (priority?.tier === "P1_URGENT" && candidateActions.includes("CALL") && features.voiceConsentAllowed) {
            baselineAction = "CALL";
        }

        let finalAction = baselineAction;
        let isAssistedByMl = false;
        let shadowPrediction = null;
        let reasonCode = "DETERMINISTIC_RULES_BASELINE";

        if (prediction?.available) {
            if (status.mode === "ACTIVE") {
                if (predictedAction !== "WAIT" && candidateActions.includes(predictedAction)) {
                    if (untouched && predictedAction === "EMAIL" && canCallFirst) {
                        finalAction = "CALL";
                        isAssistedByMl = false;
                        reasonCode = "CALL_FIRST_CADENCE";
                    } else {
                        finalAction = predictedAction;
                        isAssistedByMl = true;
                        reasonCode = prediction.reason_code || "ML_POLICY_OPTIMIZATION";
                    }
                } else if (predictedAction === "WAIT") {
                    if (untouched) {
                        finalAction = baselineAction;
                        isAssistedByMl = false;
                    } else if (
                        candidateActions.includes("CALL")
                        && features.voiceConsentAllowed
                        && Number(features.voiceAttempts || 0) === 0
                        && Number(features.emailAttempts || 0) >= 1
                    ) {
                        finalAction = "CALL";
                        isAssistedByMl = false;
                        reasonCode = "POST_EMAIL_FIRST_CALL";
                    } else {
                        finalAction = null;
                        isAssistedByMl = true;
                        reasonCode = prediction.reason_code || "ML_POLICY_OPTIMIZATION";
                    }
                }
            } else if (status.mode === "SHADOW") {
                shadowPrediction = {
                    action: predictedAction,
                    confidence: prediction.confidence,
                    modelVersion: prediction.modelVersion,
                    concursWithBaseline: predictedAction === baselineAction,
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

        const mlDelay = Number(prediction?.delay_hours ?? prediction?.delayHours);
        if (prediction?.available && Number.isFinite(mlDelay) && mlDelay >= 0) {
            delayHours = mlDelay;
        }

        if (finalAction === "EMAIL" && Number(features.emailAttempts || 0) === 0) {
            delayHours = 0;
        }

        if (finalAction === "CALL" && Number(features.linkClicks || 0) === 0) {
            const since = Number(features.hoursSinceLastTouch || 0);
            if (since < minTouchGap) {
                delayHours = Math.max(delayHours, minTouchGap - since);
            }
        }

        if (
            (finalAction === "CALL" || finalAction === null)
            && Number(features.emailAttempts || 0) >= 1
            && Number(features.voiceAttempts || 0) === 0
            && Number(features.linkClicks || 0) === 0
            && Number(features.hoursSinceLastTouch || 0) < 1
        ) {
            delayHours = Math.max(delayHours, 0.25);
        }

        delayHours = Math.min(72, Math.max(0, Number(delayHours) || 0));

        return {
            recommendedAction: finalAction,
            delayHours,
            channel: finalAction === "EMAIL" ? "EMAIL" : (finalAction === "CALL" ? "VOICE" : null),
            isAssistedByMl,
            shadowPrediction,
            confidence: isAssistedByMl ? prediction.confidence : 1.0,
            reasonCode,
            policyVersion: "nba-rules-v2",
        };
    },
};

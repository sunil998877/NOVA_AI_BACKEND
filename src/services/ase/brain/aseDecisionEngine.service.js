import { leadFeatureService } from "./leadFeature.service.js";
import { leadPriorityService } from "./leadPriority.service.js";
import { decisionPolicyService } from "./decisionPolicy.service.js";
import { modelInferenceService } from "./modelInference.service.js";
import { conversionPredictionService } from "./conversionPrediction.service.js";
import { nextBestActionService } from "./nextBestAction.service.js";
import { decisionExplanationService } from "./decisionExplanation.service.js";
import { decisionAuditService } from "./decisionAudit.service.js";
import { modelRegistry } from "./modelRegistry.service.js";
import { buildDecisionPayload, decideWithModel, normalizeModelDecision } from "./mlDecision.client.js";
import { buildOptimalSendWindow } from "../callingHours.service.js";

function resolveSchedule(lead, decision, features) {
    const delayHours = Number(decision.delayHours || 0);
    const sendWindow = buildOptimalSendWindow(lead, {
        delayHours,
        action: decision.recommendedAction || "WAIT",
        status: features.status,
        engagementScore: features.engagementScore,
        emailOpens: features.emailOpens,
    });
    const windowStart = sendWindow?.start ? new Date(sendWindow.start) : null;
    const fallback = new Date(Date.now() + delayHours * 3600 * 1000);
    return {
        delayHours,
        sendWindow,
        scheduledTime: windowStart && !Number.isNaN(windowStart.getTime()) ? windowStart : fallback,
    };
}

export const aseDecisionEngine = {
    async evaluateLead(lead, options = { audit: true }) {
        const features = leadFeatureService.extractFeatures(lead);
        if (!features) {
            return {
                leadId: null,
                action: null,
                isEligible: false,
                reason: "LEAD_RECORD_EMPTY",
                conversionPrediction: conversionPredictionService.predictConversionProbability(null),
            };
        }

        const priority = leadPriorityService.calculatePriority(lead, features);
        const eligibility = await decisionPolicyService.evaluateEligibility(lead, features);

        if (eligibility.terminal) {
            const conversionPrediction = conversionPredictionService.predictConversionProbability(features, null);
            const result = {
                leadId: lead.id,
                organizationId: features.organizationId,
                action: null,
                channel: null,
                delayHours: null,
                scheduledTime: null,
                isEligible: false,
                isTerminal: true,
                priority,
                reasonCode: eligibility.blockedReasons[0] || "TERMINAL",
                explanation: `Lead is terminal or suppressed: ${eligibility.blockedReasons.join(", ")}`,
                conversionPrediction,
                modelVersion: "rules-only",
                timestamp: new Date().toISOString(),
            };

            if (options.audit) {
                await decisionAuditService.logDecision({
                    lead,
                    decision: { recommendedAction: null, channel: "SYSTEM", delayHours: 0, reasonCode: result.reasonCode },
                    explanation: { summary: result.explanation, reasonCodes: eligibility.blockedReasons },
                    prediction: null,
                    conversionPrediction,
                });
            }
            return result;
        }

        const status = modelRegistry.getModelStatus();
        let prediction = null;

        if (status.mode === "ACTIVE") {
            try {
                prediction = normalizeModelDecision(
                    await decideWithModel(buildDecisionPayload(features, eligibility))
                );
            } catch (error) {
                console.error("ASE model service unavailable, using local inference:", error.message);
            }
        }

        if (!prediction && (eligibility.isEligible || eligibility.candidateActions.length > 0)) {
            prediction = await modelInferenceService.predict(features);
        }

        const decision = nextBestActionService.determineNextBestAction({
            eligibility,
            features,
            priority,
            prediction,
        });

        let conversionPrediction = conversionPredictionService.predictConversionProbability(features, prediction);
        if (prediction?.available && prediction.conversion_probability != null) {
            conversionPrediction.probability = conversionPredictionService.calibrateProbability(
                prediction.conversion_probability,
                {
                    status: features.status,
                    action: decision.recommendedAction || prediction.action || "WAIT",
                    probabilities: prediction.probabilities,
                    confidence: prediction.confidence,
                }
            );
            conversionPrediction.modelVersion = prediction.modelVersion || conversionPrediction.modelVersion;
            conversionPrediction.modelId = prediction.provider || conversionPrediction.modelId;
            conversionPrediction.predictionStatus = "SUCCESS";
        }

        const explanation = decisionExplanationService.generateExplanation({
            lead,
            eligibility,
            features,
            priority,
            decision,
            prediction,
        });

        const schedule = resolveSchedule(lead, decision, features);
        decision.sendWindow = schedule.sendWindow;
        decision.emailAttempts = features.emailAttempts;
        decision.voiceAttempts = features.voiceAttempts;

        const result = {
            leadId: lead.id,
            organizationId: features.organizationId,
            action: decision.recommendedAction,
            channel: decision.channel,
            delayHours: schedule.delayHours,
            scheduledTime: schedule.scheduledTime,
            sendWindow: schedule.sendWindow,
            isEligible: eligibility.isEligible && Boolean(decision.recommendedAction),
            isAssistedByMl: decision.isAssistedByMl,
            priority,
            confidence: decision.confidence,
            reasonCode: decision.reasonCode,
            explanation: prediction?.available && decision.isAssistedByMl && prediction.explanation
                ? prediction.explanation
                : explanation.summary,
            reasonCodes: explanation.reasonCodes,
            supportingMetrics: explanation.supportingMetrics,
            policyChecks: eligibility.blockedReasons,
            conversionPrediction,
            shadowPrediction: decision.shadowPrediction || null,
            modelVersion: prediction?.modelVersion || "rules-only",
            provider: decision.isAssistedByMl ? (prediction?.provider || null) : null,
            probabilities: prediction?.probabilities || null,
            rankedActions: prediction?.ranked_actions || null,
            timestamp: new Date().toISOString(),
        };

        if (options.audit) {
            await decisionAuditService.logDecision({
                lead,
                decision,
                explanation,
                prediction,
                conversionPrediction,
            });
        }

        return result;
    },

    getStatus() {
        return modelRegistry.getModelStatus();
    },

    setMode(mode) {
        return modelRegistry.setMode(mode);
    },
};

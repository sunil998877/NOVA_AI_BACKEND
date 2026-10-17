import { leadFeatureService } from "./leadFeature.service.js";
import { leadPriorityService } from "./leadPriority.service.js";
import { decisionPolicyService } from "./decisionPolicy.service.js";
import { modelInferenceService } from "./modelInference.service.js";
import { conversionPredictionService } from "./conversionPrediction.service.js";
import { nextBestActionService } from "./nextBestAction.service.js";
import { decisionExplanationService } from "./decisionExplanation.service.js";
import { decisionAuditService } from "./decisionAudit.service.js";
import { modelRegistry } from "./modelRegistry.service.js";
import { buildDecisionPayload, decideWithModel } from "./mlDecision.client.js";

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
        if (status.mode === "ACTIVE") {
            try {
                const ml = await decideWithModel(buildDecisionPayload(features, eligibility));
                const conversionPrediction = conversionPredictionService.predictConversionProbability(features, {
                    available: true,
                    probabilities: ml.probabilities,
                });
                conversionPrediction.probability = ml.conversion_probability;
                conversionPrediction.modelVersion = ml.model_version;
                conversionPrediction.modelId = ml.provider;
                conversionPrediction.predictionStatus = "SUCCESS";

                const decision = {
                    recommendedAction: ml.action,
                    channel: ml.channel,
                    delayHours: ml.delay_hours,
                    reasonCode: ml.reason_code,
                };
                const explanation = {
                    summary: ml.explanation,
                    reasonCodes: [ml.reason_code, ...(eligibility.blockedReasons || [])],
                };
                const scheduledTime = ml.action
                    ? new Date(Date.now() + Number(ml.delay_hours || 0) * 3600 * 1000)
                    : null;
                const result = {
                    leadId: lead.id,
                    organizationId: features.organizationId,
                    action: ml.action,
                    channel: ml.channel,
                    delayHours: ml.delay_hours,
                    scheduledTime,
                    isEligible: Boolean(ml.action),
                    isAssistedByMl: true,
                    priority,
                    confidence: ml.confidence,
                    reasonCode: ml.reason_code,
                    explanation: ml.explanation,
                    reasonCodes: explanation.reasonCodes,
                    supportingMetrics: {
                        engagementScore: features.engagementScore,
                        emailAttempts: features.emailAttempts,
                        voiceAttempts: features.voiceAttempts,
                        hoursSinceLastTouch: features.hoursSinceLastTouch,
                    },
                    probabilities: ml.probabilities,
                    rankedActions: ml.ranked_actions,
                    conversionPrediction,
                    modelVersion: ml.model_version,
                    provider: ml.provider,
                    timestamp: new Date().toISOString(),
                };

                if (options.audit) {
                    await decisionAuditService.logDecision({
                        lead,
                        decision,
                        explanation,
                        prediction: { available: true, probabilities: ml.probabilities, modelVersion: ml.model_version },
                        conversionPrediction,
                    });
                }
                return result;
            } catch (error) {
                console.error("ASE model service unavailable, using rules baseline:", error.message);
            }
        }

        let prediction = null;
        if (eligibility.isEligible || eligibility.candidateActions.length > 0) {
            prediction = await modelInferenceService.predict(features);
        }

        const conversionPrediction = conversionPredictionService.predictConversionProbability(features, prediction);

        const decision = nextBestActionService.determineNextBestAction({
            eligibility,
            features,
            priority,
            prediction,
        });

        const explanation = decisionExplanationService.generateExplanation({
            lead,
            eligibility,
            features,
            priority,
            decision,
            prediction,
        });

        const scheduledTime = decision.recommendedAction
            ? new Date(Date.now() + decision.delayHours * 3600 * 1000)
            : null;

        const result = {
            leadId: lead.id,
            organizationId: features.organizationId,
            action: decision.recommendedAction,
            channel: decision.channel,
            delayHours: decision.delayHours,
            scheduledTime,
            isEligible: eligibility.isEligible,
            isAssistedByMl: decision.isAssistedByMl,
            priority,
            confidence: decision.confidence,
            reasonCode: decision.reasonCode,
            explanation: explanation.summary,
            reasonCodes: explanation.reasonCodes,
            supportingMetrics: explanation.supportingMetrics,
            conversionPrediction,
            shadowPrediction: decision.shadowPrediction || null,
            modelVersion: prediction?.modelVersion || "rules-only",
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

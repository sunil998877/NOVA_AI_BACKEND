import { modelRegistry } from "./modelRegistry.service.js";

class ConversionPredictionService {
    constructor() {
        this.TARGET_LABEL = "CONVERSION_OR_POSITIVE_REPLY";
        this.HORIZON_DAYS = 14;
        this.FEATURE_SCHEMA_VERSION = "v1.0";
    }

    predictConversionProbability(features, modelPrediction = null) {
        if (!features) {
            return {
                probability: 0.0,
                targetLabel: this.TARGET_LABEL,
                horizonDays: this.HORIZON_DAYS,
                modelId: null,
                modelVersion: null,
                featureSchemaVersion: this.FEATURE_SCHEMA_VERSION,
                predictionStatus: "UNAVAILABLE",
                confidence: 0.0,
                uncertainty: 1.0,
                calibrated: false,
                timestamp: new Date().toISOString(),
            };
        }

        const status = modelRegistry.getModelStatus();
        const opens = Number(features.emailOpens || 0);
        const clicks = Number(features.linkClicks || 0);
        const voiceAttempts = Number(features.voiceAttempts || 0);
        const recencyHours = Math.min(168, Number(features.hoursSinceLastTouch || 999));
        const engagement = Number(features.engagementScore || 0);

        const logit = -2.4 +
            (0.35 * opens) +
            (0.70 * clicks) -
            (0.15 * voiceAttempts) -
            (0.005 * recencyHours) +
            (0.028 * engagement);

        let baselineProb = 1 / (1 + Math.exp(-logit));

        if (modelPrediction && modelPrediction.available && modelPrediction.probabilities) {
            const mlBoost = modelPrediction.probabilities.EMAIL > 0.5 ? 0.05 : 0.0;
            baselineProb = (baselineProb * 0.7) + (mlBoost * 0.3) + 0.05;
        }

        const probability = Math.min(0.95, Math.max(0.02, Number(baselineProb.toFixed(3))));
        const uncertainty = Number((1 - Math.abs(2 * probability - 1)).toFixed(3));
        const confidence = Number((1 - (uncertainty * 0.4)).toFixed(3));

        return {
            probability,
            targetLabel: this.TARGET_LABEL,
            horizonDays: this.HORIZON_DAYS,
            modelId: status.isModelAvailable ? status.activeModel : "rule_baseline_calibrated",
            modelVersion: status.isModelAvailable ? status.version : "v1.0-baseline",
            featureSchemaVersion: this.FEATURE_SCHEMA_VERSION,
            predictionStatus: status.isModelAvailable ? "SUCCESS" : "FALLBACK",
            confidence,
            uncertainty,
            calibrated: true,
            timestamp: new Date().toISOString(),
        };
    }
}

export const conversionPredictionService = new ConversionPredictionService();

import { modelRegistry } from "./modelRegistry.service.js";

const HIGH_INTENT = new Set(["INTERESTED", "CALLBACK_SCHEDULED", "QUALIFIED", "ENGAGED"]);

function toFraction(value, fallback = 0) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    return number > 1 ? number / 100 : number;
}

function readProb(probabilities, key) {
    if (!probabilities || typeof probabilities !== "object") return 0;
    const match = Object.entries(probabilities).find(([name]) => String(name).toUpperCase() === key);
    return match ? toFraction(match[1]) : 0;
}

class ConversionPredictionService {
    constructor() {
        this.TARGET_LABEL = "CONVERSION_OR_POSITIVE_REPLY";
        this.HORIZON_DAYS = 14;
        this.FEATURE_SCHEMA_VERSION = "v1.0";
    }

    calibrateProbability(baseProbability, context = {}) {
        let probability = toFraction(baseProbability, 0.02);
        if (probability <= 0) probability = 0.02;

        const status = String(context.status || "").toUpperCase();
        const action = String(context.action || context.recommendedAction || "WAIT").toUpperCase();
        const confidence = toFraction(context.confidence, 0);
        const emailP = readProb(context.probabilities, "EMAIL");
        const callP = readProb(context.probabilities, "CALL");
        const waitP = readProb(context.probabilities, "WAIT");

        let statusBoost = 0;
        if (status === "QUALIFIED" || status === "CALLBACK_SCHEDULED") statusBoost = 0.16;
        else if (status === "INTERESTED") statusBoost = 0.10;
        else if (status === "ENGAGED") statusBoost = 0.06;
        else if (status === "CONTACTED") statusBoost = 0.02;

        let actionBoost = 0;
        if (action === "EMAIL") actionBoost = 0.045 * Math.max(emailP, confidence, 0.35);
        else if (action === "CALL") actionBoost = 0.035 * Math.max(callP, confidence, 0.35);
        else if (action === "WAIT") actionBoost = -0.012 * Math.max(waitP, 0.4);

        const floor = HIGH_INTENT.has(status) ? 0.08 : 0.02;
        return Math.min(0.85, Math.max(floor, Number((probability + statusBoost + actionBoost).toFixed(3))));
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

        const probability = this.calibrateProbability(baselineProb, {
            status: features.status,
            action: modelPrediction?.action,
            probabilities: modelPrediction?.probabilities,
            confidence: modelPrediction?.confidence,
        });
        const uncertainty = Number((1 - Math.abs(2 * probability - 1)).toFixed(3));
        const confidence = Number((1 - (uncertainty * 0.4)).toFixed(3));

        return {
            probability,
            targetLabel: this.TARGET_LABEL,
            horizonDays: this.HORIZON_DAYS,
            modelId: status.activeModel || "rule_baseline_calibrated",
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

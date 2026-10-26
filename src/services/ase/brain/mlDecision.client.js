import { env } from "../../../config/env.js";
import { deriveModelSignals } from "./featureSchema.js";

export function buildDecisionPayload(features, eligibility) {
    const signals = deriveModelSignals(features);
    return {
        email_opens: Number(features.emailOpens || 0),
        link_clicks: Number(features.linkClicks || 0),
        email_attempts: Number(features.emailAttempts || 0),
        voice_attempts: Number(features.voiceAttempts || 0),
        hours_since_last_touch: Number(features.hoursSinceLastTouch || 0),
        engagement_score: Number(features.engagementScore || 0),
        email_consent: features.emailConsentAllowed ? 1 : 0,
        voice_consent: features.voiceConsentAllowed ? 1 : 0,
        priority: Number(features.priority || 50),
        recent_click: signals.recentClick,
        high_intent: signals.highIntent,
        fatigue: signals.fatigue,
        candidate_actions: eligibility.candidateActions || [],
    };
}

export function normalizeModelDecision(ml) {
    if (!ml) return null;
    return {
        available: true,
        action: ml.action || "WAIT",
        channel: ml.channel || null,
        confidence: Number(ml.confidence || 0),
        probabilities: ml.probabilities || null,
        modelVersion: ml.model_version || ml.modelVersion || null,
        provider: ml.provider || "fastapi-onnx-sklearn",
        reason_code: ml.reason_code || "ML_MODEL_DECISION",
        explanation: ml.explanation || "",
        ranked_actions: ml.ranked_actions || [],
        conversion_probability: ml.conversion_probability,
        delay_hours: Number(ml.delay_hours || 0),
    };
}

export async function decideWithModel(payload) {
    const base = String(env.aseMlUrl || "http://127.0.0.1:8091").replace(/\/$/, "");
    const response = await fetch(`${base}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
        throw new Error(`ASE model service returned ${response.status}`);
    }
    return response.json();
}

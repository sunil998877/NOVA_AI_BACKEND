import { env } from "../../../config/env.js";

const HIGH_INTENT = new Set(["ENGAGED", "INTERESTED", "CALLBACK_SCHEDULED", "QUALIFIED"]);

export function buildDecisionPayload(features, eligibility) {
    const emailAttempts = Number(features.emailAttempts || 0);
    const voiceAttempts = Number(features.voiceAttempts || 0);
    const linkClicks = Number(features.linkClicks || 0);
    const hours = Number(features.hoursSinceLastTouch || 0);
    const candidates = eligibility.candidateActions || [];

    return {
        email_opens: Number(features.emailOpens || 0),
        link_clicks: linkClicks,
        email_attempts: emailAttempts,
        voice_attempts: voiceAttempts,
        hours_since_last_touch: hours,
        engagement_score: Number(features.engagementScore || 0),
        email_consent: features.emailConsentAllowed ? 1 : 0,
        voice_consent: features.voiceConsentAllowed ? 1 : 0,
        priority: Number(features.priority || 50),
        recent_click: linkClicks > 0 && hours <= 48 ? 1 : 0,
        high_intent: HIGH_INTENT.has(String(features.status || "").toUpperCase()) || linkClicks >= 2 ? 1 : 0,
        fatigue: Math.min(1, (emailAttempts / 3) * 0.6 + (voiceAttempts / 2) * 0.4),
        candidate_actions: candidates,
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

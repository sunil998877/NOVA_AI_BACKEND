export const FEATURE_SCHEMA_VERSION = "v2.0";

export const FEATURE_NAMES = [
    "email_opens",
    "link_clicks",
    "email_attempts",
    "voice_attempts",
    "hours_since_last_touch",
    "engagement_score",
    "email_consent",
    "voice_consent",
    "priority",
    "recent_click",
    "high_intent",
    "fatigue",
];

export const FEATURE_SCALES = {
    email_opens: 8,
    link_clicks: 5,
    email_attempts: 3,
    voice_attempts: 2,
    hours_since_last_touch: 168,
    engagement_score: 100,
    email_consent: 1,
    voice_consent: 1,
    priority: 100,
    recent_click: 1,
    high_intent: 1,
    fatigue: 1,
};

const HIGH_INTENT = new Set(["ENGAGED", "INTERESTED", "CALLBACK_SCHEDULED", "QUALIFIED"]);

export function minTouchGapHours() {
    const value = Number(process.env.ASE_MIN_TOUCH_GAP_HOURS);
    if (!Number.isFinite(value) || value < 0) return 2;
    return value;
}

export function clipScale(value, scale) {
    const number = Number(value);
    const safe = Number.isFinite(number) ? number : 0;
    const divisor = Number(scale) > 0 ? Number(scale) : 1;
    return Math.min(1, Math.max(0, safe / divisor));
}

export function deriveModelSignals(features = {}) {
    const emailAttempts = Number(features.emailAttempts || 0);
    const voiceAttempts = Number(features.voiceAttempts || 0);
    const linkClicks = Number(features.linkClicks || 0);
    const hours = Number(features.hoursSinceLastTouch || 0);
    const recentClick = linkClicks > 0 && hours <= 48 ? 1 : 0;
    const highIntent = HIGH_INTENT.has(String(features.status || "").toUpperCase()) || linkClicks >= 2 ? 1 : 0;
    const fatigue = Math.min(1, (emailAttempts / 3) * 0.6 + (voiceAttempts / 2) * 0.4);
    return { recentClick, highIntent, fatigue };
}

export function buildScaledFeatureVector(features = {}) {
    const signals = deriveModelSignals(features);
    const raw = {
        email_opens: Number(features.emailOpens || 0),
        link_clicks: Number(features.linkClicks || 0),
        email_attempts: Number(features.emailAttempts || 0),
        voice_attempts: Number(features.voiceAttempts || 0),
        hours_since_last_touch: Math.min(168, Math.max(0, Number(features.hoursSinceLastTouch || 0))),
        engagement_score: Number(features.engagementScore || 0),
        email_consent: features.emailConsentAllowed ? 1 : 0,
        voice_consent: features.voiceConsentAllowed ? 1 : 0,
        priority: Number(features.priority || 50),
        recent_click: signals.recentClick,
        high_intent: signals.highIntent,
        fatigue: signals.fatigue,
    };
    return Float32Array.from(FEATURE_NAMES.map((name) => clipScale(raw[name], FEATURE_SCALES[name])));
}

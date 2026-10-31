import { buildScaledFeatureVector, deriveModelSignals } from "./featureSchema.js";

function parseJson(value, fallback) {
    if (!value) return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function readEngagementCounts(lead) {
    const metadata = parseJson(lead.metadata, {});
    const tracking = parseJson(lead.tracking, {});
    return {
        emailOpens: Number(
            lead.email_opens
            ?? lead.opens_count
            ?? metadata.email_opens
            ?? metadata.opens_count
            ?? tracking.opens
            ?? 0
        ),
        linkClicks: Number(
            lead.link_clicks
            ?? lead.clicks_count
            ?? metadata.link_clicks
            ?? metadata.clicks_count
            ?? tracking.clicks
            ?? 0
        ),
    };
}

export const leadFeatureService = {
    extractFeatures(lead) {
        if (!lead) return null;

        const counters = parseJson(lead.attempt_counters, { email: 0, voice: 0, total: 0 });
        const emailAttempts = Number(counters.email || 0);
        const voiceAttempts = Number(counters.voice || 0);
        const { emailOpens, linkClicks } = readEngagementCounts(lead);

        let hoursSinceLastTouch = 999;
        if (lead.last_contacted_at) {
            const diffMs = Date.now() - new Date(lead.last_contacted_at).getTime();
            hoursSinceLastTouch = Math.max(0, diffMs / (1000 * 60 * 60));
        }

        let engagementScore = Number(lead.engagement_score || 0);
        if (!lead.engagement_score) {
            const verifiedWeight = (Number(linkClicks) * 35) + (Number(emailOpens) * 8);
            engagementScore = Math.min(100, verifiedWeight);
            if (hoursSinceLastTouch > 72 && engagementScore > 0) {
                engagementScore = Math.max(5, engagementScore * 0.8);
            }
            if (emailAttempts === 0 && voiceAttempts === 0 && engagementScore === 0) {
                engagementScore = 15;
            }
        }

        const emailConsentAllowed = lead.email_consent?.status === "GRANTED" && Boolean(lead.email);
        const voiceConsentAllowed = lead.voice_consent?.status === "GRANTED" && Boolean(lead.phone);
        const signals = deriveModelSignals({
            emailAttempts,
            voiceAttempts,
            linkClicks,
            hoursSinceLastTouch,
            status: lead.status,
        });
        const features = {
            leadId: lead.id,
            organizationId: Number(lead.organization_id || 1),
            emailOpens,
            linkClicks,
            emailAttempts,
            voiceAttempts,
            hoursSinceLastTouch: Number(hoursSinceLastTouch.toFixed(1)),
            engagementScore: Number(engagementScore.toFixed(1)),
            emailConsentAllowed,
            voiceConsentAllowed,
            priority: Number(lead.priority || 50),
            status: lead.status || "NEW",
            recentClick: signals.recentClick,
            highIntent: signals.highIntent,
            fatigue: Number(signals.fatigue.toFixed(3)),
            featureSchemaVersion: "v2.0",
        };
        features.vector = buildScaledFeatureVector(features);
        return features;
    },
};

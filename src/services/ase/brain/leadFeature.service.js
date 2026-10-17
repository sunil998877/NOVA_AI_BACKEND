export const leadFeatureService = {
    extractFeatures(lead) {
        if (!lead) return null;

        const counters = typeof lead.attempt_counters === "string"
            ? JSON.parse(lead.attempt_counters || "{}")
            : (lead.attempt_counters || { email: 0, voice: 0, total: 0 });

        const emailAttempts = Number(counters.email || 0);
        const voiceAttempts = Number(counters.voice || 0);
        const emailOpens = Number(lead.email_opens || lead.opens_count || 0);
        const linkClicks = Number(lead.link_clicks || lead.clicks_count || 0);

        let hoursSinceLastTouch = 999;
        if (lead.last_contacted_at) {
            const diffMs = Date.now() - new Date(lead.last_contacted_at).getTime();
            hoursSinceLastTouch = Math.max(0, diffMs / (1000 * 60 * 60));
        }

        let engagementScore = Number(lead.engagement_score || 0);
        if (!lead.engagement_score) {
            engagementScore = Math.min(100, (emailOpens * 15) + (linkClicks * 35));
            if (hoursSinceLastTouch > 72 && engagementScore > 0) {
                engagementScore = Math.max(5, engagementScore * 0.8);
            }
            if (emailAttempts === 0 && voiceAttempts === 0 && engagementScore === 0) {
                engagementScore = 15;
            }
        }

        const emailConsentAllowed = lead.email_consent?.status !== "DENIED" && Boolean(lead.email);
        const voiceConsentAllowed = lead.voice_consent?.status !== "DENIED" && Boolean(lead.phone);

        const vector = new Float32Array([
            emailOpens,
            linkClicks,
            voiceAttempts,
            Number(hoursSinceLastTouch.toFixed(1)),
            Number(engagementScore.toFixed(1)),
        ]);

        return {
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
            vector,
        };
    },
};

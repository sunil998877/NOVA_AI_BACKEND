export const LIVE_SEGMENTS = Object.freeze([
    {
        id: "high_priority",
        name: "High priority prospects",
        criteria: "Priority ≥ 80",
        filters: { minPriority: 80 },
    },
    {
        id: "hot_callbacks",
        name: "Hot callbacks",
        criteria: "Status = CALLBACK_SCHEDULED",
        filters: { status: "CALLBACK_SCHEDULED" },
    },
    {
        id: "health_red",
        name: "Overdue health RED",
        criteria: "Health = RED",
        filters: { health: "RED" },
    },
    {
        id: "api_inbound",
        name: "API inbound",
        criteria: "Source = API",
        filters: { source: "API" },
    },
    {
        id: "consent_granted",
        name: "Email consent granted",
        criteria: "Email consent = GRANTED",
        filters: { emailConsent: "GRANTED" },
    },
    {
        id: "interested",
        name: "Interested",
        criteria: "Status = INTERESTED",
        filters: { status: "INTERESTED" },
    },
    {
        id: "dnc",
        name: "Do not contact",
        criteria: "Status = SUPPRESSED_DNC",
        filters: { status: "SUPPRESSED_DNC" },
    },
]);

export function findSegment(id) {
    return LIVE_SEGMENTS.find((segment) => segment.id === String(id || "")) || null;
}

export function filtersToQuery(filters = {}) {
    const query = {};
    if (filters.status) query.status = filters.status;
    if (filters.source) query.source = filters.source;
    if (filters.health) query.health = filters.health;
    if (filters.minPriority != null) query.min_priority = filters.minPriority;
    if (filters.emailConsent) query.email_consent = filters.emailConsent;
    if (filters.doNotContact != null) query.do_not_contact = filters.doNotContact ? 1 : 0;
    return query;
}

export const PERSONAS = Object.freeze({
    EXECUTIVE: "EXECUTIVE",
    SALES_LEADER: "SALES_LEADER",
    MARKETING: "MARKETING",
    BUSINESS_DEVELOPMENT: "BUSINESS_DEVELOPMENT",
    OPERATIONS: "OPERATIONS",
    HR_RECRUITMENT: "HR_RECRUITMENT",
    TECHNICAL: "TECHNICAL",
    GENERAL: "GENERAL",
});

const RULES = [
    { persona: PERSONAS.EXECUTIVE, pattern: /\b(founder|co-?founder|ceo|chief executive|owner|managing (director|partner)|md|president|chairman|proprietor)\b/i },
    { persona: PERSONAS.HR_RECRUITMENT, pattern: /\b(hr|human resources?|talent( acquisition)?|recruit(er|ers|ment|ing)?|people (ops|operations|partner)|hiring manager|chro)\b/i },
    { persona: PERSONAS.SALES_LEADER, pattern: /\b(sales|chief revenue officer|cro|revenue|account executive|account manager)\b/i },
    { persona: PERSONAS.MARKETING, pattern: /\b(marketing|cmo|brand|demand gen(eration)?|campaigns?|content|communications|seo)\b/i },
    { persona: PERSONAS.BUSINESS_DEVELOPMENT, pattern: /\b(business development|bdm|bde|bdr|sdr|partnerships?|growth|alliances)\b/i },
    { persona: PERSONAS.OPERATIONS, pattern: /\b(operations|coo|ops|customer success)\b/i },
    { persona: PERSONAS.TECHNICAL, pattern: /\b(cto|cio|engineer(ing)?|developer|it manager|technology|technical|architect)\b/i },
];

const PROFILES = {
    [PERSONAS.EXECUTIVE]: {
        label: "Founder / Executive",
        focusAreas: ["sales growth", "operational efficiency", "scaling outreach without adding headcount", "reducing repetitive sales work"],
        capabilityPriority: ["autonomous_sales_engine", "company_research", "follow_up_automation", "next_best_action", "ai_voice_calling"],
        keywords: ["growth", "grow", "scale", "scaling", "efficien", "repetitive", "pipeline", "team", "time"],
        tone: "brief and outcome-oriented; respect their time",
    },
    [PERSONAS.SALES_LEADER]: {
        label: "Sales leader",
        focusAreas: ["lead management", "prospect research", "follow-up automation", "sales productivity", "pipeline visibility"],
        capabilityPriority: ["follow_up_automation", "company_research", "engagement_tracking", "lead_management", "next_best_action"],
        keywords: ["pipeline", "follow-up", "follow up", "follow-ups", "rep", "productiv", "lead", "prospect", "visibility"],
        tone: "practical; talk about the team's daily workflow",
    },
    [PERSONAS.BUSINESS_DEVELOPMENT]: {
        label: "Business development",
        focusAreas: ["prospect discovery", "personalized outreach", "follow-up management", "engagement tracking"],
        capabilityPriority: ["company_research", "personalized_email", "follow_up_automation", "engagement_tracking"],
        keywords: ["prospect", "outreach", "follow", "engag", "personali", "research"],
        tone: "peer-to-peer and hands-on",
    },
    [PERSONAS.MARKETING]: {
        label: "Marketing",
        focusAreas: ["campaign personalization", "audience targeting", "engagement tracking", "outreach efficiency"],
        capabilityPriority: ["personalized_email", "email_campaigns", "engagement_tracking", "lead_management"],
        keywords: ["campaign", "audience", "engag", "personali", "open", "click", "segment"],
        tone: "focused on campaigns and audience response",
    },
    [PERSONAS.OPERATIONS]: {
        label: "Operations",
        focusAreas: ["workflow coordination", "consistent follow-through", "handoffs between email and calling"],
        capabilityPriority: ["workflow_coordination", "follow_up_automation", "next_best_action", "ai_voice_calling"],
        keywords: ["workflow", "process", "handoff", "coordinat", "consisten", "manual"],
        tone: "process-minded and specific",
    },
    [PERSONAS.HR_RECRUITMENT]: {
        label: "HR / Recruitment",
        focusAreas: ["recruitment outreach workflows", "consistent candidate and client communication", "follow-up coordination"],
        capabilityPriority: ["personalized_email", "follow_up_automation", "engagement_tracking", "workflow_coordination"],
        keywords: ["recruit", "candidate", "hiring", "outreach", "follow", "communicat"],
        tone: "warm and practical; only mention candidate communication where it is clearly relevant",
    },
    [PERSONAS.TECHNICAL]: {
        label: "Technical leader",
        focusAreas: ["workflow integration for the commercial team", "system efficiency", "one platform instead of disconnected outreach tools"],
        capabilityPriority: ["workflow_coordination", "lead_management", "autonomous_sales_engine"],
        keywords: ["platform", "workflow", "manual", "tools", "automat", "system"],
        tone: "plain and non-hyped; mention security or scalability only if PRODUCT KNOWLEDGE states it",
    },
    [PERSONAS.GENERAL]: {
        label: "Business contact (role not on record)",
        focusAreas: ["time spent researching prospects", "keeping follow-ups consistent"],
        capabilityPriority: ["company_research", "personalized_email", "follow_up_automation"],
        keywords: ["outreach", "follow", "research", "time", "prospect"],
        tone: "neutral and business-oriented; do not assume their responsibilities",
    },
};

function readObject(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
}

function firstText(...values) {
    for (const value of values) {
        const text = String(value || "").replace(/\s+/g, " ").trim();
        if (text) return text.slice(0, 120);
    }
    return "";
}

export function resolveContactFields(lead = {}) {
    const attrs = readObject(lead.segment_attributes);
    const meta = readObject(lead.metadata);
    const title = firstText(lead.title, lead.job_title, lead.designation, attrs.title, attrs.job_title, attrs.designation, meta.title, meta.job_title, meta.designation);
    const department = firstText(lead.department, attrs.department, meta.department);
    const country = firstText(lead.country, attrs.country, meta.country, lead.phone_country);
    const industry = firstText(lead.industry, attrs.industry, meta.industry);
    return { title, department, country, industry };
}

export function classifyPersona(title = "", department = "") {
    const text = `${title} ${department}`.trim();
    if (!text) return PERSONAS.GENERAL;
    const rule = RULES.find((item) => item.pattern.test(text));
    return rule ? rule.persona : PERSONAS.GENERAL;
}

export function personaProfile(persona) {
    return PROFILES[persona] || PROFILES[PERSONAS.GENERAL];
}

export function analyzeContactRole(lead = {}) {
    const fields = resolveContactFields(lead);
    const persona = classifyPersona(fields.title, fields.department);
    const profile = personaProfile(persona);
    return {
        title: fields.title || null,
        department: fields.department || null,
        country: fields.country || null,
        industry: fields.industry || null,
        titleKnown: Boolean(fields.title),
        persona,
        label: profile.label,
        focusAreas: profile.focusAreas,
        capabilityPriority: profile.capabilityPriority,
        keywords: profile.keywords,
        tone: profile.tone,
    };
}

export const QUEUE_NAMES = Object.freeze({
    LEAD_IMPORT: "nova-lead-import",
    COMPANY_RESEARCH: "nova-company-research",
    EMAIL_PERSONALIZATION: "nova-email-personalization",
    FOLLOW_UP: "nova-follow-up",
    ASE_ACTIONS: "ase-actions",
    ASE_CADENCE: "ase-cadence-steps",
});

export const JOB_NAMES = Object.freeze({
    IMPORT_LEADS: "import_leads",
    RESEARCH_COMPANY: "research_company",
    DRAFT_EMAIL: "draft_email",
    FOLLOW_UP_TASK: "follow_up_task",
    EXECUTE_ACTION: "execute_action",
    EXECUTE_CADENCE_STEP: "execute_cadence_step",
});

export const CACHE_KEYS = Object.freeze({
    RESEARCH: (domain) => `company:research:${domain}`,
    PROFILE: (orgId, companyId) => `company:profile:${orgId}:${companyId}`,
    CAMPAIGN: (campaignId) => `campaign:config:${campaignId}`,
    LOCK: (name) => `lock:${name}`,
    RATE: (name) => `rate:${name}`,
});

export const RESEARCH_CACHE_SCHEMA = 2;

export const DEFAULT_JOB_OPTIONS = Object.freeze({
    attempts: 5,
    backoff: { type: "exponential", delay: 8000 },
    removeOnComplete: { count: 1000, age: 86400 },
    removeOnFail: { count: 2000, age: 604800 },
});

export const QUEUE_CONCURRENCY = Object.freeze({
    [QUEUE_NAMES.LEAD_IMPORT]: 1,
    [QUEUE_NAMES.COMPANY_RESEARCH]: 3,
    [QUEUE_NAMES.EMAIL_PERSONALIZATION]: 2,
    [QUEUE_NAMES.FOLLOW_UP]: 2,
    [QUEUE_NAMES.ASE_ACTIONS]: 5,
    [QUEUE_NAMES.ASE_CADENCE]: Number(process.env.ASE_CADENCE_CONCURRENCY || 10),
});

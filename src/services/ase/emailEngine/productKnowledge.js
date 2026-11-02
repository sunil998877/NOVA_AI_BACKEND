import { env } from "../../../config/env.js";
import { getActivePlaybook, normalizePlaybookContent } from "../salesPlaybook.service.js";

export const NOVA_POSITIONING = "an AI-powered sales outreach and automation platform that brings prospect research, personalized emails, follow-ups, engagement tracking and AI calling together";

export const NOVA_CAPABILITIES = Object.freeze([
    { key: "company_research", name: "AI-powered company research", benefit: "researches each prospect's company from its public website before any outreach is written", keywords: ["research", "researching"] },
    { key: "lead_management", name: "lead management and enrichment", benefit: "keeps every lead, its status and its enrichment in one place", keywords: ["lead management", "enrichment", "leads in one place"] },
    { key: "personalized_email", name: "personalized email generation", benefit: "drafts an email for each prospect that a rep can review and edit before it goes out", keywords: ["personalized email", "personalised email", "personalized outreach", "personalizing"] },
    { key: "email_campaigns", name: "automated email campaigns", benefit: "runs email campaigns to the right audience segments", keywords: ["campaign"] },
    { key: "follow_up_automation", name: "automated follow-up sequences", benefit: "schedules follow-ups and pauses them as soon as a prospect replies", keywords: ["follow-up", "follow up", "follow-ups", "followup"] },
    { key: "engagement_tracking", name: "open, click and engagement tracking", benefit: "shows who opened, clicked or replied so the team knows where to focus", keywords: ["tracking", "opened", "clicked", "engagement"] },
    { key: "ai_voice_calling", name: "AI voice calling", benefit: "places AI-assisted calls and hands interested prospects to a rep", keywords: ["voice", "calling", "calls"] },
    { key: "autonomous_sales_engine", name: "the Autonomous Sales Engine", benefit: "keeps outreach running around the clock across email and calls", keywords: ["autonomous", "around the clock", "24/7"] },
    { key: "next_best_action", name: "next-best-action recommendations", benefit: "suggests the next step for each lead based on how they have engaged", keywords: ["next step", "next-best", "next best", "recommend"] },
    { key: "workflow_coordination", name: "email and calling coordination", benefit: "coordinates email and calling so a prospect is never contacted twice for the same step", keywords: ["coordinat", "one platform", "single platform", "one place"] },
]);

const BASE_NEVER_CLAIM = [
    "guaranteed revenue",
    "guaranteed conversions",
    "guaranteed deliverability",
    "inbox placement guarantee",
];

function slug(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48);
}

function keywordsOf(text) {
    return String(text || "").toLowerCase().match(/[a-z][a-z-]{4,}/g)?.slice(0, 6) || [];
}

function playbookCapabilities(playbook) {
    const features = playbook.features || [];
    const values = playbook.valuePropositions || [];
    const items = [...features, ...values].filter(Boolean).slice(0, 12);
    return items.map((item, index) => ({
        key: `playbook_${index}_${slug(item)}`,
        name: String(item),
        benefit: String(item),
        keywords: keywordsOf(item),
    }));
}

export function buildProductKnowledge(playbookInput = null, { senderName = null } = {}) {
    const fallbackBrand = env.novaSenderName || "NOVA AI";
    if (!playbookInput) {
        return {
            source: "nova_default",
            playbookVersion: null,
            brandName: fallbackBrand,
            senderName: senderName || fallbackBrand,
            productName: fallbackBrand,
            positioning: NOVA_POSITIONING,
            capabilities: [...NOVA_CAPABILITIES],
            painPoints: [],
            preferredCta: "",
            meetingLink: "",
            pricing: "",
            faqs: [],
            objections: [],
            neverClaim: [...BASE_NEVER_CLAIM],
            tone: "professional",
        };
    }
    const playbook = normalizePlaybookContent(playbookInput);
    const brandName = playbook.brandName || playbook.companyName || fallbackBrand;
    const fromPlaybook = playbookCapabilities(playbook);
    return {
        source: "sales_playbook",
        playbookVersion: playbookInput.version || null,
        brandName,
        senderName: senderName || playbook.senderName || brandName,
        productName: playbook.productName || brandName,
        positioning: playbook.productDescription || playbook.companyDescription || "",
        capabilities: fromPlaybook.length ? fromPlaybook : [...NOVA_CAPABILITIES],
        painPoints: playbook.painPoints || [],
        preferredCta: playbook.preferredCta || "",
        meetingLink: playbook.meetingLink || playbook.demoLink || "",
        pricing: String(playbook.pricing || "").trim(),
        faqs: playbook.faqs || [],
        objections: playbook.objections || [],
        neverClaim: [...BASE_NEVER_CLAIM, ...(playbook.neverClaim || [])],
        tone: playbook.emailTone || "professional",
    };
}

export async function resolveProductKnowledge(orgId, options = {}) {
    const playbook = await getActivePlaybook(Number(orgId || 0)).catch(() => null);
    return buildProductKnowledge(playbook, options);
}

function capabilityRelevance(capability, role, index) {
    const priority = role.capabilityPriority.indexOf(capability.key);
    if (priority >= 0) return 100 - priority * 10;
    const text = `${capability.name} ${capability.benefit}`.toLowerCase();
    const hits = role.keywords.filter((keyword) => text.includes(keyword)).length;
    return hits * 15 - index;
}

function industryRelevance(capability, industry) {
    if (!industry) return 0;
    const position = (industry.capabilities || []).indexOf(capability.key);
    if (position >= 0) return 45 - position * 8;
    const text = `${capability.name} ${capability.benefit}`.toLowerCase();
    return (industry.keywords || []).some((keyword) => keyword.length > 3 && text.includes(keyword)) ? 15 : 0;
}

export function selectCapabilities(knowledge, role, { exclude = [], count = 3, prefer = [], industry = null } = {}) {
    const excluded = new Set(exclude);
    const ranked = knowledge.capabilities
        .map((capability, index) => ({
            capability,
            score: capabilityRelevance(capability, role, index)
                + industryRelevance(capability, industry)
                + (prefer.includes(capability.key) ? 200 : 0),
        }))
        .sort((a, b) => b.score - a.score)
        .map((item) => item.capability);
    const fresh = ranked.filter((capability) => !excluded.has(capability.key));
    const pool = fresh.length ? fresh : ranked;
    return pool.slice(0, Math.max(1, Math.min(3, count)));
}

export function mentionedCapabilities(text, knowledge) {
    const lower = String(text || "").toLowerCase();
    return knowledge.capabilities.filter((capability) => {
        const terms = [capability.name.toLowerCase().replace(/^the /, ""), ...(capability.keywords || [])];
        return terms.some((term) => term && lower.includes(term));
    });
}

export function sellerFactsForGuard(knowledge) {
    return {
        brandName: knowledge.brandName,
        senderName: knowledge.senderName,
        productName: knowledge.productName,
        productDescription: knowledge.positioning,
        companyDescription: knowledge.positioning,
        features: knowledge.capabilities.map((capability) => `${capability.name} ${capability.benefit}`),
        valuePropositions: knowledge.capabilities.map((capability) => capability.benefit),
        pricing: knowledge.pricing,
        offers: "",
        faqs: knowledge.faqs,
        objections: knowledge.objections,
        meetingLink: knowledge.meetingLink,
        preferredCta: knowledge.preferredCta,
        neverClaim: knowledge.neverClaim,
    };
}

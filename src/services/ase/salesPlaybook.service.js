import { SalesPlaybook } from "../../models/sales-playbook.model.js";
import { bodyToHtml } from "../../utils/outreachEmail.js";

export const EMAIL_TYPES = {
    INITIAL: "INITIAL",
    FOLLOWUP: "FOLLOWUP",
    PRODUCT_INTRO: "PRODUCT_INTRO",
    DEMO_INVITE: "DEMO_INVITE",
    PRICING: "PRICING",
    MEETING_CONFIRM: "MEETING_CONFIRM",
    INFO_FOLLOWUP: "INFO_FOLLOWUP",
    REENGAGE: "REENGAGE",
};

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export const DEFAULT_TEMPLATES = {
    INITIAL: {
        subject: "A potential opportunity for {{company_name}}",
        text: `Hi {{first_name}},

I am reaching out from {{brand_name}} regarding {{relevant_business_problem}}.

Our {{product_or_service}} helps eligible businesses with {{approved_value_proposition}}.

{{preferred_cta}}

Best regards,
{{sender_name}}
{{brand_name}}`,
    },
    FOLLOWUP: {
        subject: "Re: A potential opportunity for {{company_name}}",
        text: `Hi {{first_name}},

Following up from {{brand_name}} about {{product_or_service}} for {{company_name}}.

{{approved_value_proposition}}

{{preferred_cta}}

Best regards,
{{sender_name}}
{{brand_name}}`,
    },
    PRODUCT_INTRO: {
        subject: "{{product_or_service}} for {{company_name}}",
        text: `Hi {{first_name}},

{{company_description}}

{{product_description}}

{{preferred_cta}}

Best regards,
{{sender_name}}
{{brand_name}}`,
    },
    DEMO_INVITE: {
        subject: "A brief walkthrough for {{company_name}}",
        text: `Hi {{first_name}},

I would like to walk {{company_name}} through {{product_or_service}}.

{{demo_link}}

Best regards,
{{sender_name}}
{{brand_name}}`,
    },
    PRICING: {
        subject: "Requested information for {{company_name}}",
        text: `Hi {{first_name}},

Here is the approved pricing information we can share:

{{approved_pricing}}

Best regards,
{{sender_name}}
{{brand_name}}`,
    },
    MEETING_CONFIRM: {
        subject: "Confirming our conversation",
        text: `Hi {{first_name}},

Confirming our next step for {{company_name}}.

{{meeting_link}}

Best regards,
{{sender_name}}
{{brand_name}}`,
    },
    INFO_FOLLOWUP: {
        subject: "The information you asked for",
        text: `Hi {{first_name}},

Sharing the approved information from {{brand_name}} for {{company_name}}.

{{approved_value_proposition}}

{{preferred_cta}}

Best regards,
{{sender_name}}
{{brand_name}}`,
    },
    REENGAGE: {
        subject: "Checking in with {{company_name}}",
        text: `Hi {{first_name}},

I am checking in from {{brand_name}} in case {{product_or_service}} is relevant for {{company_name}} later.

{{preferred_cta}}

Best regards,
{{sender_name}}
{{brand_name}}`,
    },
};

export function emptyPlaybookContent() {
    return {
        brandName: "",
        companyName: "",
        companyDescription: "",
        productName: "",
        productDescription: "",
        features: [],
        targetIndustries: [],
        targetRoles: [],
        icp: "",
        painPoints: [],
        valuePropositions: [],
        pricing: "",
        offers: "",
        competitorPositioning: "",
        faqs: [],
        objections: [],
        demoLink: "",
        meetingLink: "",
        qualificationQuestions: [],
        preferredCta: "Would you be interested in learning more or arranging a brief conversation?",
        emailTone: "professional",
        language: "en",
        voicePersona: "",
        voiceIntroduction: "",
        voiceGuidelines: "",
        senderName: "",
        contactEmail: "",
        contactPhone: "",
        neverClaim: [],
        emailTemplates: { ...DEFAULT_TEMPLATES },
    };
}

function asList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
    if (typeof value === "string") {
        return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
    }
    return [];
}

function asPairs(value, leftKey, rightKey) {
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (typeof item === "string") {
                    const [left, ...rest] = item.split("|");
                    return { [leftKey]: String(left || "").trim(), [rightKey]: rest.join("|").trim() };
                }
                return {
                    [leftKey]: String(item?.[leftKey] || item?.q || item?.objection || "").trim(),
                    [rightKey]: String(item?.[rightKey] || item?.a || item?.response || "").trim(),
                };
            })
            .filter((item) => item[leftKey] && item[rightKey]);
    }
    return [];
}

export function normalizePlaybookContent(raw = {}) {
    const base = emptyPlaybookContent();
    const incoming = raw && typeof raw === "object" ? raw : {};
    const templates = incoming.emailTemplates && typeof incoming.emailTemplates === "object"
        ? incoming.emailTemplates
        : {};
    return {
        ...base,
        ...incoming,
        features: asList(incoming.features),
        targetIndustries: asList(incoming.targetIndustries),
        targetRoles: asList(incoming.targetRoles),
        painPoints: asList(incoming.painPoints),
        valuePropositions: asList(incoming.valuePropositions),
        qualificationQuestions: asList(incoming.qualificationQuestions),
        neverClaim: asList(incoming.neverClaim),
        faqs: asPairs(incoming.faqs, "q", "a"),
        objections: asPairs(incoming.objections, "objection", "response"),
        emailTemplates: Object.fromEntries(
            Object.keys(DEFAULT_TEMPLATES).map((type) => {
                const override = templates[type] || {};
                return [type, {
                    subject: String(override.subject || DEFAULT_TEMPLATES[type].subject),
                    text: String(override.text || DEFAULT_TEMPLATES[type].text),
                }];
            })
        ),
    };
}

export function validatePlaybook(content) {
    const playbook = normalizePlaybookContent(content);
    const missing = [];
    if (!playbook.brandName && !playbook.companyName) missing.push("brandName");
    if (!playbook.productName && !playbook.productDescription) missing.push("productName");
    if (!playbook.valuePropositions.length) missing.push("valuePropositions");
    if (!playbook.senderName) missing.push("senderName");
    if (!playbook.painPoints.length) missing.push("painPoints");
    if (!playbook.companyDescription) missing.push("companyDescription");

    const warnings = [];
    if (!playbook.pricing) warnings.push("pricing");
    if (!playbook.demoLink && !playbook.meetingLink) warnings.push("demoOrMeetingLink");
    if (!playbook.faqs.length) warnings.push("faqs");
    if (!playbook.objections.length) warnings.push("objections");
    if (!playbook.voiceIntroduction && !playbook.voicePersona) warnings.push("voiceIntroduction");
    if (!playbook.neverClaim.length) warnings.push("neverClaim");

    return {
        missing,
        warnings,
        canSendEmail: !["brandName", "productName", "valuePropositions", "senderName"].some((key) => missing.includes(key)),
        canCall: !["brandName", "productName", "valuePropositions", "senderName"].some((key) => missing.includes(key)),
        playbook,
    };
}

function firstOf(list, fallback = "") {
    return Array.isArray(list) && list[0] ? String(list[0]) : fallback;
}

export function buildLeadVariables(playbookInput, lead = {}) {
    const playbook = normalizePlaybookContent(playbookInput);
    const firstName = String(lead.first_name || (lead.name ? String(lead.name).split(/\s+/)[0] : "") || "").trim();
    const prospectCompany = String(lead.company || "").trim();
    return {
        first_name: firstName,
        company_name: prospectCompany,
        brand_name: playbook.brandName || playbook.companyName,
        sender_name: playbook.senderName,
        product_or_service: playbook.productName || playbook.productDescription,
        product_description: playbook.productDescription,
        company_description: playbook.companyDescription,
        approved_value_proposition: firstOf(playbook.valuePropositions),
        relevant_business_problem: firstOf(playbook.painPoints),
        preferred_cta: playbook.preferredCta,
        approved_pricing: playbook.pricing,
        demo_link: playbook.demoLink,
        meeting_link: playbook.meetingLink,
        industry: lead.industry || lead.segment_attributes?.industry || firstOf(playbook.targetIndustries),
        role: lead.title || lead.segment_attributes?.title || firstOf(playbook.targetRoles),
    };
}

export function usedPlaceholders(template = "") {
    return Array.from(String(template).matchAll(PLACEHOLDER_RE), (match) => match[1]);
}

export function renderTemplate(template, variables) {
    const missing = [];
    const rendered = String(template || "").replace(PLACEHOLDER_RE, (_, key) => {
        const value = variables[key];
        if (value == null || String(value).trim() === "") {
            missing.push(key);
            return "";
        }
        return String(value);
    }).replace(/\n{3,}/g, "\n\n").trim();
    return { text: rendered, missing: [...new Set(missing)] };
}

export function renderPlaybookEmail(playbookInput, type, lead = {}) {
    const validation = validatePlaybook(playbookInput);
    const emailType = EMAIL_TYPES[type] || EMAIL_TYPES.INITIAL;
    if (!validation.canSendEmail) {
        return {
            activated: false,
            missing: validation.missing,
            type: emailType,
        };
    }

    const template = validation.playbook.emailTemplates[emailType] || DEFAULT_TEMPLATES[emailType];
    const variables = buildLeadVariables(validation.playbook, lead);
    const subjectResult = renderTemplate(template.subject, variables);
    const bodyResult = renderTemplate(template.text, variables);
    const missing = [...new Set([...subjectResult.missing, ...bodyResult.missing])];
    if (missing.length) {
        return { activated: false, missing, type: emailType };
    }

    return {
        activated: true,
        type: emailType,
        subject: subjectResult.text,
        text: bodyResult.text,
        html: bodyToHtml(bodyResult.text),
        playbookVersion: playbookInput?.version || null,
        source: "sales_playbook",
    };
}

export function buildVoiceContext(playbookInput, lead = {}) {
    const validation = validatePlaybook(playbookInput);
    if (!validation.canCall) {
        return { activated: false, missing: validation.missing };
    }

    const playbook = validation.playbook;
    const variables = buildLeadVariables(playbook, lead);
    const firstName = variables.first_name || "there";
    const constructed = `Hello ${firstName}, this is ${variables.sender_name} from ${variables.brand_name}. We help eligible businesses with ${variables.approved_value_proposition}. Is now a good time for a brief conversation?`;
    const openingSource = playbook.voiceIntroduction || constructed;
    const opening = renderTemplate(openingSource, { ...variables, first_name: firstName });
    if (opening.missing.length) {
        return { activated: false, missing: opening.missing };
    }

    return {
        activated: true,
        openingLine: opening.text,
        persona: playbook.voicePersona || variables.sender_name,
        guidelines: playbook.voiceGuidelines,
        qualificationQuestions: playbook.qualificationQuestions,
        faqs: playbook.faqs,
        objections: playbook.objections,
        neverClaim: playbook.neverClaim,
        preferredCta: playbook.preferredCta,
        demoLink: playbook.demoLink,
        meetingLink: playbook.meetingLink,
        productName: variables.product_or_service,
        brandName: variables.brand_name,
        senderName: variables.sender_name,
        valueProposition: variables.approved_value_proposition,
        variables: {
            lead_name: lead.name || firstName,
            first_name: firstName,
            company_name: variables.company_name,
            brand_name: variables.brand_name,
            sender_name: variables.sender_name,
            product_name: variables.product_or_service,
            value_proposition: variables.approved_value_proposition,
            pain_points: playbook.painPoints.join("; "),
            qualification_questions: playbook.qualificationQuestions.join("; "),
            faqs: playbook.faqs.map((item) => `${item.q} ${item.a}`).join(" | "),
            objections: playbook.objections.map((item) => `${item.objection} ${item.response}`).join(" | "),
            never_claim: playbook.neverClaim.join("; "),
            voice_persona: playbook.voicePersona,
            voice_guidelines: playbook.voiceGuidelines,
            preferred_cta: playbook.preferredCta,
            demo_link: playbook.demoLink,
            opening_line: opening.text,
        },
    };
}

export function playbookFactsForAi(playbookInput) {
    const playbook = normalizePlaybookContent(playbookInput);
    return {
        brandName: playbook.brandName || playbook.companyName,
        senderName: playbook.senderName,
        productName: playbook.productName,
        productDescription: playbook.productDescription,
        valuePropositions: playbook.valuePropositions,
        painPoints: playbook.painPoints,
        pricing: playbook.pricing,
        neverClaim: playbook.neverClaim,
        preferredCta: playbook.preferredCta,
        tone: playbook.emailTone,
    };
}

export async function getOrgPlaybook(orgId) {
    if (!orgId) return null;
    return SalesPlaybook.findByOrg(orgId);
}

export async function getActivePlaybook(orgId) {
    const row = await getOrgPlaybook(orgId);
    if (!row || String(row.status).toUpperCase() !== "ACTIVE") return null;
    return {
        ...normalizePlaybookContent(row.content),
        version: row.version,
        status: row.status,
        id: row.id,
        organization_id: row.organization_id,
    };
}

export async function saveOrgPlaybook(orgId, rawContent, status) {
    const validation = validatePlaybook(rawContent);
    const nextStatus = String(status || "DRAFT").toUpperCase() === "ACTIVE" && validation.canSendEmail
        ? "ACTIVE"
        : (String(status || "DRAFT").toUpperCase() === "ACTIVE" ? "DRAFT" : String(status || "DRAFT").toUpperCase());
    const saved = await SalesPlaybook.upsert(orgId, {
        content: validation.playbook,
        status: nextStatus,
        missingFields: [...validation.missing, ...validation.warnings],
    });
    return {
        playbook: saved,
        validation: {
            ...validation,
            canActivate: validation.canSendEmail,
            status: saved?.status,
        },
    };
}

export async function tryPlaybookEmail(lead, type = EMAIL_TYPES.INITIAL) {
    try {
        const orgId = Number(lead?.organization_id || 0);
        const playbook = await getActivePlaybook(orgId);
        if (!playbook) return null;
        const rendered = renderPlaybookEmail(playbook, type, lead);
        if (!rendered.activated) return null;
        return {
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            sellerContext: {
                company: playbook.companyName || playbook.brandName,
                summary: playbook.companyDescription,
                coreServices: playbook.productName || playbook.productDescription,
                industry: playbook.targetIndustries[0] || "",
                targetAudience: playbook.icp || playbook.targetRoles.join(", "),
                source: "sales_playbook",
            },
            playbookVersion: playbook.version,
            emailType: rendered.type,
            source: "sales_playbook",
        };
    } catch {
        return null;
    }
}

export async function tryPlaybookVoice(lead) {
    try {
        const orgId = Number(lead?.organization_id || 0);
        const playbook = await getActivePlaybook(orgId);
        if (!playbook) return null;
        const context = buildVoiceContext(playbook, lead);
        return context.activated ? context : null;
    } catch {
        return null;
    }
}

export function followupTypeForStep(stepNumber) {
    if (Number(stepNumber) >= 5) return EMAIL_TYPES.REENGAGE;
    if (Number(stepNumber) === 4) return EMAIL_TYPES.DEMO_INVITE;
    if (Number(stepNumber) === 2) return EMAIL_TYPES.PRODUCT_INTRO;
    return EMAIL_TYPES.FOLLOWUP;
}

import { getOpenAiClient } from "../../controllers/OpenAI/client.js";
import { env } from "../../config/env.js";
import { heuristicResearch, loadCompanyContext, rememberCompanyResearch, researchCompany } from "./companyResearch.service.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { bodyToHtml, formatFirstName, sanitizeOutreachEmail } from "../../utils/outreachEmail.js";
import { tryPlaybookEmail, EMAIL_TYPES } from "./salesPlaybook.service.js";
import { validateEmailDraft } from "./emailQuality.service.js";

function resolveSenderName(options = {}) {
    return options.senderName || env.novaSenderName || "NOVA AI";
}

function attachQuality(email, research, senderName) {
    const cleaned = sanitizeOutreachEmail(email, senderName);
    const qualityChecks = validateEmailDraft({
        subject: cleaned.subject,
        text: cleaned.text,
        html: cleaned.html,
        research,
    });
    return { ...cleaned, research, qualityChecks };
}

function conservativeEmail({ firstName, company, senderName, research }) {
    const known = research?.summary
        || (research?.qualityStatus === "INSUFFICIENT_EVIDENCE"
            ? `${company} is the organization on this lead record. Public website evidence was not available, so this note stays general.`
            : `${company} is the organization we would like to speak with.`);
    const subject = `A note for ${company}`;
    const text = `Dear ${firstName},\n\nI am reaching out from ${senderName} regarding ${company}. ${known}\n\nIf it would be useful, I would welcome a short conversation about whether our work is relevant to your team.\n\nLooking forward to your thoughts.\n\nBest regards,\n${senderName}`;
    return attachQuality({ subject, text, html: bodyToHtml(text) }, research, senderName);
}

async function writeEmailFromResearch(client, { firstName, company, role, senderName, research }) {
    if (!research?.summary || research.qualityStatus === "INSUFFICIENT_EVIDENCE") return null;
    const completion = await client.chat.completions.create({
        model: process.env.ASE_RESEARCH_MODEL || "gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: `Write one professional outreach email using only the supplied research. Do not invent metrics, customers, or familiarity. Sign only as ${senderName}. Output valid JSON.` },
            { role: "user", content: `Recipient first name: ${firstName}
Prospect company: ${company}
Role: ${role || "Decision maker"}
Sender brand: ${senderName}
Verified summary: ${research.summary}
Verified services: ${research.coreServices || ""}
Audience: ${research.targetAudience || ""}
Quality: ${research.qualityStatus || "UNKNOWN"}

Return JSON with subject, text, and html. Subject under 10 words. Body under 140 words. One clear CTA. No invented metrics.` },
        ],
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
    if (!parsed.subject || (!parsed.html && !parsed.text)) return null;
    const drafted = attachQuality({
        subject: parsed.subject,
        text: parsed.text || String(parsed.html).replace(/<[^>]+>/g, ""),
        html: parsed.html || bodyToHtml(parsed.text),
    }, research, senderName);
    if (!drafted.qualityChecks.eligibleToSend) return null;
    return drafted;
}

export async function draftCompanyPersonalizedEmail(lead, options = {}) {
    const playbookEmail = await tryPlaybookEmail(lead, options.emailType || EMAIL_TYPES.INITIAL);
    if (playbookEmail) return playbookEmail;

    const rawCompany = lead.company || "";
    const emailDomain = lead.email ? lead.email.split("@")[1] : "";
    const domainCompany = emailDomain && !["gmail.com", "yahoo.com", "outlook.com", "hotmail.com"].includes(emailDomain.toLowerCase())
        ? emailDomain.split(".")[0].replace(/[-_]/g, " ")
        : "";
    const company = rawCompany || (domainCompany ? domainCompany.charAt(0).toUpperCase() + domainCompany.slice(1) : "your company");

    const firstName = formatFirstName(lead.first_name || (lead.name ? lead.name.split(" ")[0] : "there"));
    const senderName = resolveSenderName(options);
    const role = lead.title || lead.segment_attributes?.title || "";
    const context = await loadCompanyContext(company, { domain: emailDomain, leadInfo: lead });
    const client = getOpenAiClient();
    let research = context.cachedResearch || null;
    if (!research?.summary) {
        try {
            research = await researchCompany(company, { domain: emailDomain, leadInfo: lead });
        } catch {}
    }

    if (client && research?.summary) {
        try {
            const fromResearch = await writeEmailFromResearch(client, {
                firstName, company, role, senderName, research,
            });
            if (fromResearch) return { ...fromResearch, research };
        } catch {}
    }

    research = research || heuristicResearch(context);
    rememberCompanyResearch(context.effectiveDomain, context.effectiveCompany, research);
    return conservativeEmail({ firstName, company, senderName, research });
}

function readMetadata(lead) {
    if (!lead?.metadata) return {};
    if (typeof lead.metadata === "string") {
        try {
            return JSON.parse(lead.metadata);
        } catch {
            return {};
        }
    }
    return lead.metadata;
}

export async function storeOutreachDraft(lead, research = null) {
    if (!lead?.id) return null;
    const orgId = Number(lead.organization_id || 1);
    const existing = readMetadata(lead);
    if (existing.outreach_email?.subject && (existing.outreach_email?.text || existing.outreach_email?.html)) {
        const senderName = env.novaSenderName || "NOVA AI";
        const cleaned = sanitizeOutreachEmail(existing.outreach_email, senderName);
        if (cleaned.text !== existing.outreach_email.text || cleaned.html !== existing.outreach_email.html) {
            await Lead.updateById(lead.id, {
                metadata: {
                    ...existing,
                    outreach_email: {
                        ...existing.outreach_email,
                        ...cleaned,
                        updated_at: new Date().toISOString(),
                    },
                },
            }, orgId);
        }
        return cleaned;
    }

    const drafted = await draftCompanyPersonalizedEmail({
        ...lead,
        metadata: {
            ...existing,
            company_research: research || existing.company_research || null,
        },
    });

    const outreachEmail = {
        subject: drafted.subject,
        text: drafted.text,
        html: drafted.html,
        written_at: new Date().toISOString(),
        is_edited: false,
        qualityChecks: drafted.qualityChecks || null,
        approvalStatus: "pending",
    };

    const metadata = {
        ...existing,
        company_research: drafted.research || research || existing.company_research || null,
        company_research_status: (drafted.research || research || existing.company_research)?.summary ? "ready" : existing.company_research_status,
        outreach_status: "ready",
        outreach_email: outreachEmail,
    };

    await Lead.updateById(lead.id, { metadata }, orgId);

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        user_id: lead.user_id || null,
        channel: "EMAIL",
        event_type: "EMAIL_DRAFTED",
        status: "COMPLETED",
        payload: {
            subject: outreachEmail.subject,
            company: metadata.company_research?.company || lead.company,
        },
    });

    return outreachEmail;
}

export async function prepareCompanyOutreach(lead) {
    if (!lead?.id || !lead.email) return null;
    const existing = readMetadata(lead);
    if (existing.outreach_email?.subject && existing.company_research?.summary) {
        return {
            lead,
            research: existing.company_research,
            email: existing.outreach_email,
        };
    }

    const drafted = await draftCompanyPersonalizedEmail(lead);
    const metadata = {
        ...existing,
        company_research: drafted.research,
        outreach_status: "ready",
        outreach_email: {
            subject: drafted.subject,
            text: drafted.text,
            html: drafted.html,
            written_at: new Date().toISOString(),
        },
    };
    const organizationId = Number(lead.organization_id || 1);
    const updated = await Lead.updateById(lead.id, { metadata }, organizationId);

    await LeadEvent.create({
        organization_id: organizationId,
        lead_id: lead.id,
        user_id: lead.user_id || null,
        channel: "AI_RESEARCH",
        event_type: "COMPANY_RESEARCHED",
        status: "COMPLETED",
        payload: {
            company: drafted.research?.company,
            summary: drafted.research?.summary,
            coreServices: drafted.research?.coreServices,
            industry: drafted.research?.industry,
            targetAudience: drafted.research?.targetAudience,
            source: drafted.research?.source,
        },
    });
    await LeadEvent.create({
        organization_id: organizationId,
        lead_id: lead.id,
        user_id: lead.user_id || null,
        channel: "EMAIL",
        event_type: "EMAIL_DRAFTED",
        status: "COMPLETED",
        payload: {
            subject: drafted.subject,
            company: drafted.research?.company,
        },
    });

    return {
        lead: updated || { ...lead, metadata },
        research: drafted.research,
        email: metadata.outreach_email,
    };
}


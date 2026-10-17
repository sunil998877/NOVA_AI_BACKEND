import { getOpenAiClient } from "../../controllers/OpenAI/client.js";
import { env } from "../../config/env.js";
import { heuristicResearch, loadCompanyContext, rememberCompanyResearch } from "./companyResearch.service.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";

async function writeEmailFromResearch(client, { firstName, company, role, senderName, research }) {
    const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: "Write one professional email from the company analysis. Output valid JSON only." },
            { role: "user", content: `Recipient: ${firstName}
Company: ${company}
Role: ${role || "Decision maker"}
Sender: ${senderName}
Summary: ${research.summary}
Services: ${research.coreServices}
Audience: ${research.targetAudience}
Return JSON with subject, text, and html. Under 140 words. No invented metrics.` },
        ],
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
    if (!parsed.subject || (!parsed.html && !parsed.text)) return null;
    return {
        subject: parsed.subject,
        text: parsed.text || String(parsed.html).replace(/<[^>]+>/g, ""),
        html: parsed.html || `<p>${String(parsed.text).replace(/\n\n/g, "</p><p>")}</p>`,
    };
}

export async function draftCompanyPersonalizedEmail(lead, options = {}) {
    const rawCompany = lead.company || "";
    const emailDomain = lead.email ? lead.email.split("@")[1] : "";
    const domainCompany = emailDomain && !["gmail.com", "yahoo.com", "outlook.com", "hotmail.com"].includes(emailDomain.toLowerCase())
        ? emailDomain.split(".")[0].replace(/[-_]/g, " ")
        : "";
    const company = rawCompany || (domainCompany ? domainCompany.charAt(0).toUpperCase() + domainCompany.slice(1) : "your company");

    const firstName = lead.first_name || (lead.name ? lead.name.split(" ")[0] : "there");
    const senderName = options.senderName || env.novaSenderName || "NOVA Sales";
    const role = lead.title || lead.segment_attributes?.title || "";
    const context = await loadCompanyContext(company, { domain: emailDomain, leadInfo: lead });
    const client = getOpenAiClient();

    if (client && context.cachedResearch?.summary) {
        try {
            const fromCache = await writeEmailFromResearch(client, {
                firstName, company, role, senderName, research: context.cachedResearch,
            });
            if (fromCache) return { ...fromCache, research: context.cachedResearch };
        } catch {}
    }

    if (client && !context.cachedResearch) {
        try {
            const completion = await client.chat.completions.create({
                model: "gpt-4o-mini",
                temperature: 0.4,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: "Analyze the company, then write one professional email from that analysis. Output valid JSON only." },
                    { role: "user", content: `Company: ${context.effectiveCompany}
Domain: ${context.effectiveDomain || emailDomain || "unknown"}
Website title: ${context.siteData?.title || "N/A"}
Website description: ${context.siteData?.description || "N/A"}
Recipient first name: ${firstName}
Role: ${role || "Decision maker"}
Sender: ${senderName}

Return JSON:
{
  "summary": "2 sentences on what the company does",
  "coreServices": "their main offerings",
  "industry": "industry",
  "targetAudience": "who they sell to",
  "growthOpportunity": "one concrete reason to talk",
  "subject": "professional subject under 9 words",
  "text": "plain email under 140 words",
  "html": "same email with paragraph tags"
}
Use only the website signals. No invented metrics. No exclamation marks. Close with Best regards, ${senderName}.` },
                ],
            });
            const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
            if (parsed.summary && parsed.subject && (parsed.html || parsed.text)) {
                const research = {
                    company: context.effectiveCompany,
                    summary: parsed.summary,
                    coreServices: parsed.coreServices || "",
                    industry: parsed.industry || "",
                    targetAudience: parsed.targetAudience || "",
                    growthOpportunity: parsed.growthOpportunity || "",
                    source: "ai_intelligence",
                };
                rememberCompanyResearch(context.effectiveDomain, context.effectiveCompany, research);
                return {
                    subject: parsed.subject,
                    text: parsed.text || String(parsed.html).replace(/<[^>]+>/g, ""),
                    html: parsed.html || `<p>${String(parsed.text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
                    research,
                };
            }
        } catch {}
    }

    const research = context.cachedResearch || heuristicResearch(context);
    rememberCompanyResearch(context.effectiveDomain, context.effectiveCompany, research);

    const offering = research.coreServices || research.summary || "the work your team is doing";
    const subject = `${company}: a note on ${research.industry || "your work"}`;
    const text = `Hi ${firstName},\n\nI spent some time looking at ${company}. ${research.summary}\n\nThat focus on ${offering} is why I am writing. I would like to share one practical idea for how ${company} reaches ${research.targetAudience || "the customers you already serve"}, and hear whether it is relevant.\n\nWould you be open to a short conversation this week?\n\nBest regards,\n${senderName}`;
    const html = `<p>Hi ${firstName},</p><p>I spent some time looking at <strong>${company}</strong>. ${research.summary}</p><p>That focus on ${offering} is why I am writing. I would like to share one practical idea for how ${company} reaches ${research.targetAudience || "the customers you already serve"}, and hear whether it is relevant.</p><p>Would you be open to a short conversation this week?</p><p>Best regards,<br>${senderName}</p>`;

    return { subject, text, html, research };
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

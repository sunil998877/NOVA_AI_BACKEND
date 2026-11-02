import { env } from "../../config/env.js";
import { isUsableResearchProfile, researchCompany } from "./companyResearch.service.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { sanitizeOutreachEmail } from "../../utils/outreachEmail.js";
import { tryPlaybookEmail, EMAIL_TYPES } from "./salesPlaybook.service.js";
import {
    draftedEventPayload,
    generateSalesEmail,
    readLeadMetadata,
    toStoredOutreachEmail,
} from "./emailEngine/salesEmailEngine.service.js";

function engineOptions(options = {}) {
    const senderName = typeof options.senderName === "string" && options.senderName.trim()
        ? options.senderName.trim().slice(0, 80)
        : null;
    return {
        senderName,
        client: options.client,
        campaign: options.campaign || null,
        ...(options.research !== undefined ? { research: options.research } : {}),
    };
}

export async function draftCompanyPersonalizedEmail(lead, options = {}) {
    const emailType = options.emailType || EMAIL_TYPES.INITIAL;
    if (emailType !== EMAIL_TYPES.INITIAL) {
        const playbookEmail = await tryPlaybookEmail(lead, emailType);
        if (playbookEmail) {
            const known = readLeadMetadata(lead).company_research;
            const research = isUsableResearchProfile(known)
                ? known
                : await researchCompany(lead.company || "", { domain: lead.email?.split("@")[1] || null, leadInfo: lead }).catch(() => null);
            return { ...playbookEmail, research };
        }
    }
    return generateSalesEmail(lead, engineOptions(options));
}

async function logDrafted(lead, drafted, { orgId, userId = null, company = null }) {
    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        user_id: userId || lead.user_id || null,
        channel: "EMAIL",
        event_type: "EMAIL_DRAFTED",
        status: drafted.generation_status === "READY" ? "COMPLETED" : "PENDING_REVIEW",
        payload: draftedEventPayload(drafted, company || drafted.research?.company || lead.company),
    }).catch((err) => console.warn(`[EmailEngine] could not log EMAIL_DRAFTED for lead ${lead.id}: ${err.message}`));
}

export async function draftAndStoreLeadEmail(lead, { userId = null, ...options } = {}) {
    const orgId = Number(lead.organization_id || 1);
    const existing = readLeadMetadata(lead);
    const drafted = await draftCompanyPersonalizedEmail(lead, options);
    if (drafted.blocked) {
        await LeadEvent.create({
            organization_id: orgId,
            lead_id: lead.id,
            user_id: userId,
            channel: "EMAIL",
            event_type: "EMAIL_GENERATION_BLOCKED",
            status: "BLOCKED",
            payload: { reason: drafted.block_reason, message: drafted.block_message },
            idempotency_key: `email_gen_blocked_${orgId}_${lead.id}_${drafted.block_reason}`,
        }).catch(() => {});
        return { drafted, lead, email: null };
    }
    const outreachEmail = toStoredOutreachEmail(drafted, { previous: existing.outreach_email });
    const research = drafted.research || existing.company_research || null;
    const metadata = {
        ...existing,
        company_research: research,
        company_research_status: research?.summary ? "ready" : existing.company_research_status,
        outreach_status: "ready",
        outreach_email: outreachEmail,
    };
    const updated = await Lead.updateById(lead.id, { metadata }, orgId);
    await logDrafted(lead, drafted, { orgId, userId });
    return { drafted, lead: updated || { ...lead, metadata }, email: outreachEmail };
}

export async function storeOutreachDraft(lead, research = null) {
    if (!lead?.id) return null;
    const orgId = Number(lead.organization_id || 1);
    const existing = readLeadMetadata(lead);
    if (existing.outreach_email?.subject && (existing.outreach_email?.text || existing.outreach_email?.html) && !existing.outreach_email.sent_at) {
        const senderName = env.novaSenderName || "NOVA AI";
        const cleaned = sanitizeOutreachEmail(existing.outreach_email, senderName);
        if (!existing.outreach_email.generation_version && (cleaned.text !== existing.outreach_email.text || cleaned.html !== existing.outreach_email.html)) {
            await Lead.updateById(lead.id, {
                metadata: {
                    ...existing,
                    outreach_email: { ...existing.outreach_email, ...cleaned, updated_at: new Date().toISOString() },
                },
            }, orgId);
        }
        return { ...existing.outreach_email, ...(existing.outreach_email.generation_version ? {} : cleaned) };
    }
    const { email } = await draftAndStoreLeadEmail({
        ...lead,
        metadata: { ...existing, company_research: research || existing.company_research || null },
    });
    return email;
}

export async function prepareCompanyOutreach(lead) {
    if (!lead?.id || !lead.email) return null;
    const existing = readLeadMetadata(lead);
    if (existing.outreach_email?.subject && existing.company_research?.summary && !existing.outreach_email.sent_at) {
        return { lead, research: existing.company_research, email: existing.outreach_email };
    }
    const { drafted, lead: updated, email } = await draftAndStoreLeadEmail(lead);
    if (!email) return null;
    if (drafted.research) {
        await LeadEvent.create({
            organization_id: Number(lead.organization_id || 1),
            lead_id: lead.id,
            user_id: lead.user_id || null,
            channel: "AI_RESEARCH",
            event_type: "COMPANY_RESEARCHED",
            status: "COMPLETED",
            payload: {
                company: drafted.research.company,
                summary: drafted.research.summary,
                coreServices: drafted.research.coreServices,
                industry: drafted.research.industry,
                targetAudience: drafted.research.targetAudience,
                source: drafted.research.source,
            },
        }).catch(() => {});
    }
    return { lead: updated, research: drafted.research, email };
}

import { Lead } from "../../../models/lead.model.js";
import { storeOutreachDraft } from "../../ase/leadEmailDrafter.service.js";
import { emitOrgEvent, publishAseEvent } from "../realtime.js";

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

async function markOutreachStatus(lead, orgId, status, extra = {}) {
    const meta = readMetadata(lead);
    await Lead.updateById(lead.id, {
        metadata: { ...meta, ...extra, outreach_status: status },
    }, orgId).catch((err) => {
        console.warn(`[EmailPersonalization] could not set outreach_status=${status} for lead ${lead.id}: ${err.message}`);
    });
}

export async function processEmailPersonalizationJob(job) {
    const { leadId, organizationId } = job.data || {};
    const orgId = Number(organizationId || 1);
    const lead = await Lead.findById(leadId, orgId);
    if (!lead) return { skipped: true, reason: "lead_missing" };
    if (lead.do_not_contact) {
        await markOutreachStatus(lead, orgId, "blocked", { company_research_status: readMetadata(lead).company_research_status });
        return { skipped: true, reason: "dnc" };
    }

    const meta = readMetadata(lead);
    if (meta.outreach_email?.subject && meta.outreach_email?.text && !meta.outreach_email?.sent_at) {
        if (meta.outreach_status === "writing") await markOutreachStatus(lead, orgId, "ready");
        return { skipped: true, reason: "draft_exists", subject: meta.outreach_email.subject };
    }

    await markOutreachStatus(lead, orgId, "writing");
    await publishAseEvent("EMAIL_PERSONALIZATION_REQUESTED", {
        organization_id: orgId,
        lead_id: lead.id,
        channel: "EMAIL",
        status: "PENDING",
    });
    emitOrgEvent(orgId, "email_personalization_started", {
        jobId: job.id,
        leadId: Number(lead.id),
        status: "writing",
    });

    const fresh = await Lead.findById(lead.id, orgId);
    const research = readMetadata(fresh || lead).company_research || meta.company_research || null;

    let drafted = null;
    try {
        drafted = await storeOutreachDraft(fresh || lead, research);
    } catch (err) {
        console.error(`[EmailPersonalization] draft failed for lead ${lead.id}:`, err.message);
        await markOutreachStatus(fresh || lead, orgId, "failed");
        emitOrgEvent(orgId, "email_personalization_failed", {
            jobId: job.id,
            leadId: Number(lead.id),
            status: "failed",
            error: err.message,
        });
        throw err;
    }

    if (!drafted?.subject) {
        await markOutreachStatus(fresh || lead, orgId, "failed");
        emitOrgEvent(orgId, "email_personalization_failed", {
            jobId: job.id,
            leadId: Number(lead.id),
            status: "failed",
        });
        return { ok: false, leadId: Number(lead.id) };
    }

    const quality = drafted.qualityChecks || {};
    const eventName = quality.eligibleToSend === false ? "EMAIL_READY_FOR_APPROVAL" : "EMAIL_PERSONALIZATION_COMPLETED";
    emitOrgEvent(orgId, "email_personalization_completed", {
        jobId: job.id,
        leadId: Number(lead.id),
        status: quality.eligibleToSend === false ? "review" : "completed",
    });
    await publishAseEvent(eventName, {
        organization_id: orgId,
        lead_id: lead.id,
        channel: "EMAIL",
        status: quality.eligibleToSend === false ? "PENDING_REVIEW" : "COMPLETED",
        payload: {
            subject: drafted.subject,
            generation_status: drafted.generation_status || null,
            quality_score: drafted.quality_score ?? null,
        },
    });
    return { ok: true, leadId: Number(lead.id), subject: drafted.subject };
}

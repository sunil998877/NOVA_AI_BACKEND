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

export async function processEmailPersonalizationJob(job) {
    const { leadId, organizationId } = job.data || {};
    const orgId = Number(organizationId || 1);
    const lead = await Lead.findById(leadId, orgId);
    if (!lead) return { skipped: true, reason: "lead_missing" };
    if (lead.do_not_contact) return { skipped: true, reason: "dnc" };

    await publishAseEvent("EMAIL_PERSONALIZATION_REQUESTED", {
        organization_id: orgId,
        lead_id: lead.id,
        channel: "EMAIL",
        status: "PENDING",
    });

    const research = readMetadata(lead).company_research || null;
    const drafted = await storeOutreachDraft(lead, research);
    if (!drafted?.subject) {
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
        payload: { subject: drafted.subject },
    });
    return { ok: true, leadId: Number(lead.id), subject: drafted.subject };
}

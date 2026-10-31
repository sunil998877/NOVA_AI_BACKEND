import { addQueueJob, getQueue } from "./queue.registry.js";
import { JOB_NAMES, QUEUE_NAMES } from "./queue.constants.js";
import { LeadImportJob } from "../../models/lead-import-job.model.js";
import { shouldEnqueueToRedis } from "../../config/redis.js";

export async function enqueueLeadImportJob({ organizationId, userId, source, updateExisting, leads }) {
    if (!shouldEnqueueToRedis() || !getQueue(QUEUE_NAMES.LEAD_IMPORT)) return null;
    const job = await LeadImportJob.create({
        organizationId,
        userId,
        source,
        updateExisting,
        totalRows: Array.isArray(leads) ? leads.length : 0,
        payload: { leads },
    });
    if (!job) return null;
    const queued = await addQueueJob(
        QUEUE_NAMES.LEAD_IMPORT,
        JOB_NAMES.IMPORT_LEADS,
        { importJobId: job.id, organizationId: Number(organizationId), userId: userId || null },
        { jobId: `import:${job.id}` }
    );
    if (!queued) {
        await LeadImportJob.updateById(job.id, organizationId, { status: "failed", error_summary: [{ error: "queue_unavailable" }], completed_at: new Date() });
        return null;
    }
    return {
        queued: true,
        jobId: job.id,
        queueJobId: queued.id,
        status: "queued",
        total: job.total_rows,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
    };
}

export async function enqueueCompanyResearchJob(lead) {
    if (!lead?.id) return null;
    if (!shouldEnqueueToRedis() || !getQueue(QUEUE_NAMES.COMPANY_RESEARCH)) return null;
    const orgId = Number(lead.organization_id || 1);
    return addQueueJob(
        QUEUE_NAMES.COMPANY_RESEARCH,
        JOB_NAMES.RESEARCH_COMPANY,
        { leadId: Number(lead.id), organizationId: orgId, userId: lead.user_id || null },
        { jobId: `research:${orgId}:${lead.id}` }
    );
}

export async function enqueueEmailPersonalizationJob(lead, research = null) {
    if (!lead?.id) return null;
    if (!shouldEnqueueToRedis() || !getQueue(QUEUE_NAMES.EMAIL_PERSONALIZATION)) return null;
    const orgId = Number(lead.organization_id || 1);
    return addQueueJob(
        QUEUE_NAMES.EMAIL_PERSONALIZATION,
        JOB_NAMES.DRAFT_EMAIL,
        { leadId: Number(lead.id), organizationId: orgId, userId: lead.user_id || null, hasResearch: Boolean(research) },
        { jobId: `draft:${orgId}:${lead.id}` }
    );
}

export async function enqueueFollowUpTaskJob(task) {
    if (!task?.id) return null;
    if (!shouldEnqueueToRedis() || !getQueue(QUEUE_NAMES.FOLLOW_UP)) return null;
    const orgId = Number(task.organization_id || 1);
    return addQueueJob(
        QUEUE_NAMES.FOLLOW_UP,
        JOB_NAMES.FOLLOW_UP_TASK,
        { taskId: Number(task.id), organizationId: orgId, leadId: Number(task.lead_id || 0) },
        { jobId: `followup:${orgId}:${task.id}` }
    );
}

export async function enqueueAseActionJob(payload, options = {}) {
    if (!shouldEnqueueToRedis() || !getQueue(QUEUE_NAMES.ASE_ACTIONS)) return null;
    return addQueueJob(
        QUEUE_NAMES.ASE_ACTIONS,
        JOB_NAMES.EXECUTE_ACTION,
        payload,
        { jobId: options.jobId, delay: options.delayMs || 0, attempts: options.maxAttempts }
    );
}

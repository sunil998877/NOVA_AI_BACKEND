import { processBatch } from "../../leads/leadIntake.service.js";
import { LeadImportJob } from "../../../models/lead-import-job.model.js";
import { emitOrgEvent, publishAseEvent } from "../realtime.js";

export async function processLeadImportJob(job) {
    const { importJobId, organizationId, userId } = job.data || {};
    const orgId = Number(organizationId || 1);
    const record = await LeadImportJob.findById(importJobId, orgId);
    if (!record) throw new Error("import_job_missing");
    if (record.status === "completed") return { skipped: true, reason: "already_completed" };

    await LeadImportJob.updateById(importJobId, orgId, { status: "active" });
    emitOrgEvent(orgId, "lead_import_progress", {
        jobId: importJobId,
        status: "active",
        processed: 0,
        total: record.total_rows,
    });

    const payload = await LeadImportJob.getPayload(importJobId, orgId);
    const leads = Array.isArray(payload?.leads) ? payload.leads : [];
    const summary = await processBatch(leads, {
        organizationId: orgId,
        userId,
        source: record.source,
        updateExisting: Boolean(record.update_existing),
        onProgress: async (processed) => {
            await job.updateProgress(Math.round((processed / Math.max(record.total_rows, 1)) * 100));
            emitOrgEvent(orgId, "lead_import_progress", {
                jobId: importJobId,
                status: "active",
                processed,
                total: record.total_rows,
            });
        },
    });

    const completed = await LeadImportJob.updateById(importJobId, orgId, {
        status: "completed",
        processed: summary.total,
        accepted: summary.accepted,
        created_count: summary.created,
        updated_count: summary.updated,
        skipped: summary.skipped,
        rejected: summary.rejected,
        failed: summary.failed,
        error_summary: summary.errors || [],
        completed_at: new Date(),
    });

    emitOrgEvent(orgId, "lead_import_completed", {
        jobId: importJobId,
        status: "completed",
        created: summary.created,
        updated: summary.updated,
        skipped: summary.skipped,
        failed: summary.failed,
        total: summary.total,
    });
    await publishAseEvent("LEAD_CREATED", {
        organization_id: orgId,
        lead_id: null,
        channel: "SYSTEM",
        status: "COMPLETED",
        payload: { importJobId, created: summary.created, updated: summary.updated },
    });
    return completed;
}

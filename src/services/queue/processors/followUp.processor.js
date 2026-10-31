import { FollowUpTask } from "../../../models/follow-up-task.model.js";
import { followUpScheduler } from "../../followup/followUpScheduler.service.js";
import { emitOrgEvent, publishAseEvent } from "../realtime.js";

export async function processFollowUpJob(job) {
    const { taskId, organizationId, leadId } = job.data || {};
    const orgId = Number(organizationId || 1);
    const task = await FollowUpTask.findById(taskId, orgId);
    if (!task) return { skipped: true, reason: "task_missing" };
    const status = String(task.status || "").toUpperCase();
    if (["SENT", "CANCELLED", "FAILED", "SKIPPED", "BLOCKED_REPLY"].includes(status)) {
        return { skipped: true, reason: status };
    }

    await followUpScheduler.processTask(task);
    emitOrgEvent(orgId, "followup_scheduled", {
        jobId: job.id,
        leadId: Number(leadId || task.lead_id || 0),
        taskId: Number(task.id),
        status: "processed",
    });
    await publishAseEvent("FOLLOWUP_SCHEDULED", {
        organization_id: orgId,
        lead_id: Number(leadId || task.lead_id || 0) || null,
        channel: "EMAIL",
        status: "PROCESSED",
        payload: { taskId: Number(task.id) },
    });
    return { ok: true, taskId: Number(task.id) };
}

import { asyncHandler } from "../../utils/asyncHandler.js";
import { query } from "../../config/db.js";
import { FollowUpSequence } from "../../models/follow-up-sequence.model.js";
import { FollowUpEnrollment } from "../../models/follow-up-enrollment.model.js";
import { FollowUpTask } from "../../models/follow-up-task.model.js";
import { FollowUpAutomation } from "../../models/follow-up-automation.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { followUpEngine } from "../../services/followup/followUpEngine.service.js";
import { followUpContentService } from "../../services/followup/followUpContent.service.js";
import { followUpScheduler } from "../../services/followup/followUpScheduler.service.js";

export const listSequences = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const sequences = await FollowUpSequence.list(orgId);
    return res.status(200).json({ data: sequences });
});

export const getSequence = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const sequence = await FollowUpSequence.findById(req.params.id, orgId);
    if (!sequence) return res.status(404).json({ error: "Follow-up sequence not found" });
    return res.status(200).json({ data: sequence });
});

export const createSequence = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const created = await FollowUpSequence.create({
        ...req.body,
        organization_id: orgId,
    });
    return res.status(201).json({ data: created });
});

export const updateSequence = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const updated = await FollowUpSequence.updateById(req.params.id, req.body, orgId);
    if (!updated) return res.status(404).json({ error: "Follow-up sequence not found" });
    return res.status(200).json({ data: updated });
});

export const deleteSequence = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const ok = await FollowUpSequence.deleteById(req.params.id, orgId);
    if (!ok) return res.status(404).json({ error: "Follow-up sequence not found" });
    return res.status(200).json({ data: { deleted: true } });
});

export const listEnrollments = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const status = req.query.status || null;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const enrollments = await FollowUpEnrollment.list(orgId, { status, limit, offset });
    const enriched = await Promise.all(
        enrollments.map(async (e) => {
            const lead = await Lead.findById(e.lead_id, orgId);
            const tasks = await FollowUpTask.findByEnrollmentId(e.id, orgId);
            const completedSteps = tasks.filter((t) => t.status === "SENT").length;
            const remainingSteps = tasks.filter((t) => t.status === "SCHEDULED" || t.status === "PROCESSING").length;
            const nextTask = tasks.find((t) => t.status === "SCHEDULED") || null;
            const lastSentTask = [...tasks].reverse().find((t) => t.status === "SENT") || null;
            const lastFailedTask = tasks.find((t) => t.status === "FAILED") || null;

            let computedStatus = e.status;
            if (lead?.do_not_contact) {
                computedStatus = "Suppressed";
            }

            return {
                ...e,
                lead,
                tasks,
                completed_steps: completedSteps,
                remaining_steps: remainingSteps,
                next_action: nextTask ? `Step ${nextTask.step_number}` : null,
                next_due_at: nextTask ? nextTask.scheduled_at : null,
                last_executed_at: lastSentTask ? lastSentTask.sent_at : null,
                last_failure_reason: lastFailedTask ? lastFailedTask.last_error : e.paused_reason,
                computed_status: computedStatus,
            };
        })
    );
    return res.status(200).json({ data: enriched });
});

export const getEnrollment = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const enrollment = await FollowUpEnrollment.findById(req.params.id, orgId);
    if (!enrollment) return res.status(404).json({ error: "Enrollment not found" });

    const lead = await Lead.findById(enrollment.lead_id, orgId);
    const tasks = await FollowUpTask.findByEnrollmentId(enrollment.id, orgId);
    return res.status(200).json({ data: { enrollment, lead, tasks } });
});

export const enrollLead = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const leadId = req.body.leadId || req.body.lead_id;
    if (!leadId) return res.status(400).json({ error: "leadId is required" });

    const lead = await Lead.findById(leadId, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const result = await followUpEngine.enrollLead(lead, req.body.initialContext || req.body);
    return res.status(201).json({ data: result });
});

export const pauseEnrollment = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const reason = req.body.reason || "Paused via control panel";
    const updated = await FollowUpEnrollment.pause(req.params.id, reason, orgId);
    if (!updated) return res.status(404).json({ error: "Enrollment not found" });
    await FollowUpTask.cancelRemaining(req.params.id, reason, "CANCELLED", orgId);
    await LeadEvent.create({
        organization_id: orgId,
        lead_id: updated.lead_id,
        user_id: req.user.id || null,
        channel: "EMAIL",
        event_type: "FOLLOW_UP_PAUSED",
        status: "PAUSED",
        payload: {
            enrollmentId: updated.id,
            reason,
            pausedBy: req.user.email || "user",
        },
    });
    return res.status(200).json({ data: updated });
});

export const resumeEnrollment = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    try {
        const updated = await followUpEngine.resumeLeadSequence(req.params.id, req.user, orgId);
        return res.status(200).json({ data: updated });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

export const stopEnrollment = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const reason = req.body.reason || "Stopped permanently via control panel";
    try {
        const updated = await followUpEngine.stopLeadSequence(req.params.id, reason, req.user, orgId);
        return res.status(200).json({ data: updated });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

export const cancelEnrollment = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const reason = req.body.reason || "Cancelled via control panel";
    const updated = await FollowUpEnrollment.cancel(req.params.id, reason, orgId);
    if (!updated) return res.status(404).json({ error: "Enrollment not found" });
    await FollowUpTask.cancelRemaining(req.params.id, reason, "CANCELLED", orgId);
    return res.status(200).json({ data: updated });
});

export const markReplyProcessed = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    try {
        const updated = await followUpEngine.markReplyProcessed(req.params.id, req.user, orgId);
        return res.status(200).json({ data: updated });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

export const listReplies = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const rows = await query(
        `SELECT le.id, le.lead_id, le.event_type, le.status, le.payload, le.createdAt,
                l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                fe.id AS enrollment_id, fe.status AS sequence_status, fe.reply_outcome
         FROM lead_events le
         LEFT JOIN leads l ON l.id = le.lead_id
         LEFT JOIN follow_up_enrollments fe ON fe.lead_id = le.lead_id
         WHERE le.organization_id = ? AND le.event_type = 'EMAIL_REPLY_RECEIVED'
         ORDER BY le.createdAt DESC LIMIT ? OFFSET ?`,
        [orgId, limit, offset]
    );

    return res.status(200).json({ data: rows });
});

export const listBlockedTasks = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const tasks = await FollowUpTask.listBlocked(orgId, { limit, offset });
    const enriched = await Promise.all(
        tasks.map(async (t) => {
            const lead = await Lead.findById(t.lead_id, orgId);
            const enrollment = await FollowUpEnrollment.findById(t.enrollment_id, orgId);
            return { ...t, lead, enrollment };
        })
    );

    return res.status(200).json({ data: enriched });
});

export const getLeadJourney = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const leadId = req.params.leadId;
    const enrollments = await FollowUpEnrollment.findByLeadId(leadId, orgId);
    const tasks = await FollowUpTask.findByLeadId(leadId, orgId);
    return res.status(200).json({ data: { enrollments, tasks } });
});

export const previewTaskContent = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const task = await FollowUpTask.findById(req.params.id, orgId);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const lead = await Lead.findById(task.lead_id, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const enrollment = await FollowUpEnrollment.findById(task.enrollment_id, orgId);
    const preview = await followUpContentService.generateStepContent(task.step_number, lead, {
        subject: enrollment?.initial_subject,
        messageId: enrollment?.initial_message_id,
    });
    return res.status(200).json({ data: preview });
});

export const updateTask = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const updated = await FollowUpTask.updateById(req.params.id, req.body, orgId);
    if (!updated) return res.status(404).json({ error: "Task not found" });
    return res.status(200).json({ data: updated });
});

export const retryTask = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    try {
        const updated = await followUpEngine.retryTask(req.params.id, orgId);
        followUpScheduler.kick();
        return res.status(200).json({ data: updated });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

export const getAutomationStatus = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const settings = await FollowUpAutomation.getSettings(orgId);
    const counts = await FollowUpEnrollment.countByStatus(orgId);
    return res.status(200).json({ data: { settings, counts } });
});

export const startAutomation = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const result = await followUpEngine.startAutomation({ orgId, user: req.user });
    return res.status(200).json({ data: result });
});

export const pauseAutomation = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const { scope = "organization", id = null, reason = "Automation paused via control panel" } = req.body || {};
    const result = await followUpEngine.pauseAutomation({ scope, id, reason, user: req.user, orgId });
    return res.status(200).json({ data: result });
});

export const resumeAutomation = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const { scope = "organization", id = null } = req.body || {};
    const result = await followUpEngine.resumeAutomation({ scope, id, user: req.user, orgId });
    return res.status(200).json({ data: result });
});

export const stopAutomation = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const { scope = "organization", id = null, reason = "Automation stopped via control panel" } = req.body || {};
    const result = await followUpEngine.stopAutomation({ scope, id, reason, user: req.user, orgId });
    return res.status(200).json({ data: result });
});

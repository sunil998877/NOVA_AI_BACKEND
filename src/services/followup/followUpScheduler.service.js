import { query } from "../../config/db.js";
import { FollowUpTask } from "../../models/follow-up-task.model.js";
import { FollowUpEnrollment } from "../../models/follow-up-enrollment.model.js";
import { FollowUpSequence } from "../../models/follow-up-sequence.model.js";
import { FollowUpAutomation } from "../../models/follow-up-automation.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { unifiedDeliveryService } from "../email/unifiedDelivery.service.js";
import { eventBus } from "../ase/eventBus.service.js";
import { canAutoDispatch } from "../ase/operatingMode.service.js";
import { enqueuePendingApproval } from "../ase/approvalQueue.service.js";
import { isConsentGranted } from "../ase/consent.service.js";
import { enqueueFollowUpTaskJob } from "../queue/enqueue.js";

class FollowUpSchedulerService {
    constructor() {
        this.isRunning = false;
        this.timer = null;
        this.pollIntervalMs = 20000;
        this.isProcessing = false;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.poll();
    }

    stop() {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    kick() {
        if (!this.isRunning) return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.poll();
    }

    async poll() {
        if (!this.isRunning || this.isProcessing) return;
        this.isProcessing = true;
        try {
            await this.processDueTasks();
        } catch (error) {
            console.error("[FollowUp Scheduler] Error during cycle:", error.message);
        } finally {
            this.isProcessing = false;
            if (this.isRunning) {
                this.timer = setTimeout(() => this.poll(), this.pollIntervalMs);
            }
        }
    }

    async processDueTasks() {
        const now = new Date();
        const dueTasks = await FollowUpTask.findDueTasks(null, 10, now);
        if (!dueTasks || dueTasks.length === 0) return;

        for (const task of dueTasks) {
            const queued = await enqueueFollowUpTaskJob(task);
            if (queued) {
                await eventBus.publish("FOLLOWUP_SCHEDULED", {
                    organization_id: Number(task.organization_id || 1),
                    lead_id: task.lead_id || null,
                    channel: "EMAIL",
                    status: "QUEUED",
                    payload: { taskId: task.id, queueJobId: queued.id },
                }).catch(() => {});
                continue;
            }
            await this.processTask(task);
        }
    }

    async processTask(task) {
            const orgId = Number(task.organization_id || 1);
            const dispatchGate = await canAutoDispatch("EMAIL", { organizationId: orgId });
            if (!dispatchGate.allowed) {
                if (dispatchGate.enqueue && task.lead_id) {
                    await enqueuePendingApproval({
                        organizationId: orgId,
                        leadId: task.lead_id,
                        action: "EMAIL",
                        payload: { source: "follow_up", taskId: task.id },
                    }).catch(() => {});
                }
                return;
            }

            const isOrgActive = await FollowUpAutomation.isAutomationActive(orgId);
            if (!isOrgActive) {
                return;
            }

            const sequence = await FollowUpSequence.findById(task.sequence_id, orgId);
            if (sequence && !sequence.is_active) {
                return;
            }

            if (task.lead_id) {
                const heldLead = await Lead.findById(task.lead_id, orgId);
                if (heldLead?.metadata?.outreach_hold?.held) {
                    return;
                }
            }

            const claimed = await FollowUpTask.claimForProcessing(task.id, orgId);
            if (!claimed) return;

            try {
                const enrollment = await FollowUpEnrollment.findById(task.enrollment_id, orgId);
                const isActive = enrollment && (enrollment.status === "ACTIVE" || enrollment.status === "active");
                if (!enrollment || !isActive) {
                    const blockStatus = enrollment?.status === "paused_reply_received" ? "BLOCKED_REPLY" : "CANCELLED";
                    await FollowUpTask.updateById(task.id, {
                        status: blockStatus,
                        last_error: `Sequence inactive (status: ${enrollment?.status || "missing"})`,
                    }, orgId);
                    await LeadEvent.create({
                        organization_id: orgId,
                        lead_id: task.lead_id,
                        channel: "EMAIL",
                        event_type: "FOLLOW_UP_BLOCKED",
                        status: "BLOCKED",
                        payload: {
                            taskId: task.id,
                            enrollmentId: enrollment?.id,
                            stepNumber: task.step_number,
                            reason: `Enrollment status is ${enrollment?.status || "missing"}`,
                        },
                    });
                    return;
                }

                const lead = await Lead.findById(task.lead_id, orgId);
                if (lead?.metadata?.outreach_hold?.held) {
                    await FollowUpTask.updateById(task.id, { status: "SCHEDULED" }, orgId).catch(() => {});
                    return;
                }
                if (!lead || !lead.email || lead.do_not_contact) {
                    await FollowUpTask.updateById(task.id, { status: "CANCELLED", last_error: "Lead missing or marked DNC" }, orgId);
                    await FollowUpEnrollment.cancel(enrollment.id, "Lead marked DNC", orgId);
                    return;
                }
                if (!isConsentGranted(lead.email_consent)) {
                    if (lead.email_consent?.status === "DENIED") {
                        await FollowUpTask.updateById(task.id, { status: "CANCELLED", last_error: "Email consent denied" }, orgId);
                        await FollowUpEnrollment.cancel(enrollment.id, "Email consent denied", orgId);
                    }
                    return;
                }

                if (["MEETING_BOOKED", "CALLBACK", "CALLBACK_SCHEDULED", "INTERESTED", "HANDED_OFF", "WARM_TRANSFER"].includes(lead.status)) {
                    await FollowUpTask.updateById(task.id, { status: "CANCELLED", last_error: "Meeting already booked" }, orgId);
                    await FollowUpEnrollment.markMeetingBooked(enrollment.id, orgId);
                    return;
                }

                const replyRows = await query(
                    `SELECT id FROM lead_events
                     WHERE lead_id = ? AND organization_id = ? AND event_type = 'EMAIL_REPLY_RECEIVED'
                       AND created_at >= ? LIMIT 1`,
                    [lead.id, orgId, enrollment.initial_sent_at || enrollment.created_at]
                );
                if (replyRows && replyRows.length > 0) {
                    await FollowUpEnrollment.markReplied(enrollment.id, {}, orgId);
                    await FollowUpTask.updateById(task.id, {
                        status: "BLOCKED_REPLY",
                        last_error: "Prospect reply already recorded; outreach blocked",
                    }, orgId);
                    await LeadEvent.create({
                        organization_id: orgId,
                        lead_id: lead.id,
                        user_id: lead.user_id || null,
                        channel: "EMAIL",
                        event_type: "FOLLOW_UP_BLOCKED",
                        status: "BLOCKED",
                        payload: {
                            taskId: task.id,
                            enrollmentId: enrollment.id,
                            stepNumber: task.step_number,
                            reason: "Prospect reply recorded prior to dispatch",
                        },
                    });
                    return;
                }

                const domain = lead.email.split("@")[1] || null;
                const suppressed = await Suppression.isSuppressed(orgId, { email: lead.email, phone: lead.phone, domain });
                if (suppressed) {
                    await FollowUpTask.updateById(task.id, { status: "CANCELLED", last_error: "Suppression match" }, orgId);
                    await FollowUpEnrollment.cancel(enrollment.id, "Lead on suppression list", orgId);
                    return;
                }

                const recheckTask = await FollowUpTask.findById(task.id, orgId);
                if (!recheckTask || recheckTask.status !== "PROCESSING") {
                    return;
                }

                const recheckEnrollment = await FollowUpEnrollment.findById(enrollment.id, orgId);
                if (!recheckEnrollment || (recheckEnrollment.status !== "active" && recheckEnrollment.status !== "ACTIVE")) {
                    await FollowUpTask.updateById(task.id, {
                        status: recheckEnrollment?.status === "paused_reply_received" ? "BLOCKED_REPLY" : "CANCELLED",
                        last_error: `Enrollment transitioned to ${recheckEnrollment?.status} before dispatch`,
                    }, orgId);
                    return;
                }

                const headers = {};
                if (task.thread_mode === "REPLY_THREAD" && task.in_reply_to) {
                    headers["In-Reply-To"] = task.in_reply_to;
                    headers["References"] = task.in_reply_to;
                }

                const idempotencyKey = `followup_${enrollment.id}_step_${task.step_number}_${Date.now()}`;
                const deliveryResult = await unifiedDeliveryService.deliverSingle({
                    orgId,
                    to: lead.email,
                    subject: task.subject,
                    text: task.body_text,
                    html: task.body_html,
                    headers,
                    leadId: lead.id,
                    idempotencyKey,
                });

                if (deliveryResult.status === "SUCCEEDED") {
                    const messageId = deliveryResult.messageId || `fut-msg-${Date.now()}`;
                    await FollowUpTask.updateById(task.id, {
                        status: "SENT",
                        sent_at: new Date(),
                        message_id: messageId,
                        last_error: null,
                    }, orgId);

                    const nextStep = task.step_number + 1;
                    const isFinal = task.step_number >= enrollment.total_steps;
                    if (isFinal) {
                        await FollowUpEnrollment.updateById(enrollment.id, {
                            current_step: nextStep,
                            status: "completed",
                            completed_at: new Date(),
                        }, orgId);
                    } else {
                        await FollowUpEnrollment.updateById(enrollment.id, {
                            current_step: nextStep,
                        }, orgId);
                    }

                    const counters = lead.attempt_counters || { email: 0, voice: 0, total: 0 };
                    counters.email = (counters.email || 0) + 1;
                    counters.total = (counters.total || 0) + 1;

                    await Lead.updateById(lead.id, {
                        attempt_counters: counters,
                        last_contacted_at: new Date(),
                    }, orgId);

                    await LeadEvent.create({
                        organization_id: orgId,
                        lead_id: lead.id,
                        user_id: lead.user_id || null,
                        channel: "EMAIL",
                        event_type: isFinal ? "FOLLOW_UP_COMPLETED" : "FOLLOW_UP_SENT",
                        status: "COMPLETED",
                        payload: {
                            enrollmentId: enrollment.id,
                            stepNumber: task.step_number,
                            subject: task.subject,
                            threadMode: task.thread_mode,
                            messageId,
                        },
                        idempotency_key: `lead_${lead.id}_step_${task.step_number}_sent`,
                    });
                } else if (deliveryResult.status === "SKIPPED") {
                    await FollowUpTask.updateById(task.id, {
                        status: "SKIPPED",
                        last_error: deliveryResult.skipReason || "Compliance check skipped",
                    }, orgId);
                } else {
                    const retries = (task.retry_count || 0) + 1;
                    if (retries < 3) {
                        const backoffMinutes = retries === 1 ? 30 : 120;
                        const nextAttempt = new Date(Date.now() + backoffMinutes * 60 * 1000);
                        await FollowUpTask.updateById(task.id, {
                            status: "SCHEDULED",
                            retry_count: retries,
                            scheduled_at: nextAttempt,
                            last_error: deliveryResult.error || "Transient delivery error",
                        }, orgId);
                    } else {
                        await FollowUpTask.updateById(task.id, {
                            status: "FAILED",
                            retry_count: retries,
                            last_error: deliveryResult.error || "Permanent delivery failure after 3 attempts",
                        }, orgId);
                    }
                }
            } catch (taskErr) {
                console.error(`[FollowUp Scheduler] Error processing task ${task.id}:`, taskErr.message);
                await FollowUpTask.updateById(task.id, {
                    status: "FAILED",
                    last_error: taskErr.message,
                }, orgId);
            }
    }
}

export const followUpScheduler = new FollowUpSchedulerService();

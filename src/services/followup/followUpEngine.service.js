import { execute, query } from "../../config/db.js";
import { FollowUpSequence } from "../../models/follow-up-sequence.model.js";
import { FollowUpEnrollment } from "../../models/follow-up-enrollment.model.js";
import { FollowUpTask } from "../../models/follow-up-task.model.js";
import { FollowUpAutomation } from "../../models/follow-up-automation.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { followUpContentService } from "./followUpContent.service.js";
import { followUpScheduler } from "./followUpScheduler.service.js";
import { getIo } from "../../socket/socketServer.js";
import { eventBus } from "../ase/eventBus.service.js";
import { ASE_OUTCOMES } from "../ase/outcomeNormalizer.service.js";
import { env } from "../../config/env.js";
import { unifiedDeliveryService } from "../email/unifiedDelivery.service.js";

function resolveReplyOutcome(raw) {
    if (!raw) return ASE_OUTCOMES.AMBIGUOUS;
    if (typeof raw === "string") return raw;
    return raw.normalizedOutcome || raw.outcome || ASE_OUTCOMES.AMBIGUOUS;
}

function shouldSkipReplySend() {
    return process.env.ASE_SKIP_OUTREACH === "1"
        || process.env.NODE_ENV === "test"
        || typeof process.env.NODE_TEST_CONTEXT !== "undefined";
}

const DEFAULT_SCHEDULE = [
    { stepNumber: 1, dayOffset: 2, threadMode: "REPLY_THREAD" },
    { stepNumber: 2, dayOffset: 7, threadMode: "NEW_THREAD" },
    { stepNumber: 3, dayOffset: 14, threadMode: "NEW_THREAD" },
    { stepNumber: 4, dayOffset: 28, threadMode: "NEW_THREAD" },
    { stepNumber: 5, dayOffset: 42, threadMode: "REPLY_THREAD" },
];

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function resolveFollowUpTimezone(config = {}) {
    if (config.timezone && config.timezone !== "UTC") return config.timezone;
    return env.callingTimezone || "Asia/Kolkata";
}

function getZonedParts(date, timeZone) {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
    const map = {};
    for (const part of formatter.formatToParts(date)) {
        map[part.type] = part.value;
    }
    return {
        weekday: WEEKDAY[map.weekday] ?? 0,
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: Number(map.hour === "24" ? 0 : map.hour),
        minute: Number(map.minute),
        second: Number(map.second),
    };
}

function addCalendarDays(year, month, day, days) {
    const utc = new Date(Date.UTC(year, month - 1, day + Number(days || 0)));
    return {
        year: utc.getUTCFullYear(),
        month: utc.getUTCMonth() + 1,
        day: utc.getUTCDate(),
        weekday: utc.getUTCDay(),
    };
}

function zonedTimeToUtc(timeZone, year, month, day, hour, minute) {
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
    const got = getZonedParts(new Date(utcGuess), timeZone);
    const gotUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, 0);
    return new Date(utcGuess + (utcGuess - gotUtc));
}

export function calculateScheduledDate(initialSentAt, dayOffset, config = {}) {
    const timeZone = resolveFollowUpTimezone(config);
    const bypassDays = env.bypassTimingGates && typeof process.env.NODE_TEST_CONTEXT === "undefined";
    const allowedDays = bypassDays
        ? [0, 1, 2, 3, 4, 5, 6]
        : (config.sending_days && Array.isArray(config.sending_days) ? config.sending_days : [1, 2, 3, 4, 5]);
    const windowStartHour = config.sending_window_start ? parseInt(config.sending_window_start.split(":")[0], 10) : 9;
    const windowStartMin = config.sending_window_start ? parseInt(config.sending_window_start.split(":")[1] || "0", 10) : 0;
    const windowEndHour = config.sending_window_end ? parseInt(config.sending_window_end.split(":")[0], 10) : 18;
    const base = getZonedParts(new Date(initialSentAt), timeZone);
    let cursor = addCalendarDays(base.year, base.month, base.day, dayOffset);

    while (!allowedDays.includes(cursor.weekday)) {
        cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, 1);
    }

    let hour = base.hour;
    let minute = base.minute;
    if (hour < windowStartHour) {
        hour = windowStartHour;
        minute = windowStartMin;
    } else if (hour >= windowEndHour) {
        cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, 1);
        while (!allowedDays.includes(cursor.weekday)) {
            cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, 1);
        }
        hour = windowStartHour;
        minute = windowStartMin;
    }

    return zonedTimeToUtc(timeZone, cursor.year, cursor.month, cursor.day, hour, minute);
}

export const followUpEngine = {
    async autoEnrollLead(lead, initialContext = {}) {
        if (!lead || !lead.id || !lead.email) return null;
        const orgId = Number(lead.organization_id || initialContext.organizationId || 1);

        const isEnabled = await FollowUpAutomation.isAutoEnrollEnabled(orgId);
        if (!isEnabled) {
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "FOLLOW_UP_SKIPPED",
                status: "SKIPPED",
                payload: { reason: "Automation is paused or disabled" },
                idempotency_key: `lead_${lead.id}_skip_automation_disabled`,
            });
            return { status: "skipped", reason: "automation_disabled" };
        }

        if (lead.do_not_contact) {
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "FOLLOW_UP_SKIPPED",
                status: "SKIPPED",
                payload: { reason: "Lead marked Do Not Contact" },
                idempotency_key: `lead_${lead.id}_skip_dnc`,
            });
            return { status: "skipped", reason: "dnc" };
        }

        if (lead.email_consent && typeof lead.email_consent === "object" && lead.email_consent.status === "DENIED") {
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "FOLLOW_UP_SKIPPED",
                status: "SKIPPED",
                payload: { reason: "Email consent was denied" },
                idempotency_key: `lead_${lead.id}_skip_consent_denied`,
            });
            return { status: "skipped", reason: "consent_denied" };
        }

        const domain = lead.email ? lead.email.split("@")[1] : null;
        const isSuppressed = await Suppression.isSuppressed(orgId, { email: lead.email, phone: lead.phone, domain });
        if (isSuppressed) {
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "FOLLOW_UP_SKIPPED",
                status: "SKIPPED",
                payload: { reason: "Recipient on suppression list" },
                idempotency_key: `lead_${lead.id}_skip_suppressed`,
            });
            return { status: "skipped", reason: "suppressed" };
        }

        if (lead.status === "MEETING_BOOKED") {
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "FOLLOW_UP_SKIPPED",
                status: "SKIPPED",
                payload: { reason: "Meeting already booked for this lead" },
                idempotency_key: `lead_${lead.id}_skip_meeting_booked`,
            });
            return { status: "skipped", reason: "meeting_booked" };
        }

        const existingList = await FollowUpEnrollment.findByLeadId(lead.id, orgId);
        if (existingList && existingList.length > 0) {
            const existing = existingList[0];
            const terminalStates = new Set(["stopped_meeting_booked", "stopped_unsubscribed", "stopped_do_not_contact", "completed", "stopped"]);
            if (terminalStates.has(existing.status)) {
                return { status: "skipped", reason: "terminal_state", enrollment: existing };
            }
            return { status: "already_enrolled", enrollment: existing, tasks: await FollowUpTask.findByEnrollmentId(existing.id, orgId) };
        }

        const result = await this.enrollLead(lead, initialContext);
        if (result && result.enrollment) {
            const enrolledSteps = (result.tasks || []).map((task) => ({
                stepNumber: task.step_number,
                dayOffset: task.day_offset,
                scheduledAt: task.scheduled_at,
            }));
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "FOLLOWUP_ENROLLED",
                status: "ACTIVE",
                payload: {
                    enrollmentId: result.enrollment.id,
                    totalSteps: result.tasks?.length || 5,
                    firstScheduledAt: result.tasks?.[0]?.scheduled_at,
                    scheduledSteps: enrolledSteps,
                },
                idempotency_key: `lead_${lead.id}_auto_enrolled_${result.enrollment.id}`,
            });

            try {
                await eventBus.publish("FOLLOWUP_ENROLLED", {
                    organization_id: orgId,
                    lead_id: lead.id,
                    enrollment_id: result.enrollment.id,
                });
            } catch (_) {}

            return { status: "enrolled", enrollment: result.enrollment, tasks: result.tasks };
        }

        return { status: "failed", reason: "enrollment_error" };
    },

    async enrollLead(lead, initialContext = {}) {
        if (!lead || !lead.id || !lead.email) return null;
        const orgId = Number(lead.organization_id || 1);

        const existing = await FollowUpEnrollment.findActiveByLeadId(lead.id, orgId);
        if (existing) {
            return { enrollment: existing, tasks: await FollowUpTask.findByEnrollmentId(existing.id, orgId) };
        }

        let sequence = await FollowUpSequence.findActiveDefault(orgId);
        if (!sequence) {
            sequence = await FollowUpSequence.create({
                organization_id: orgId,
                name: "Default Follow-Up Sequence",
                description: "Standard 5-touch cold email sequence (Day 2, 7, 14, 28, 42)",
                steps_config: DEFAULT_SCHEDULE,
            });
        }

        const steps = (sequence.steps_config && sequence.steps_config.length > 0)
            ? sequence.steps_config
            : DEFAULT_SCHEDULE;

        const initialSentAt = initialContext.sentAt ? new Date(initialContext.sentAt) : new Date();
        const initialSubject = initialContext.subject || lead.metadata?.outreach_email?.subject || null;
        const initialMessageId = initialContext.messageId || null;
        const initialMailId = initialContext.mailId || null;
        const campaignId = initialContext.campaignId || null;

        const enrollment = await FollowUpEnrollment.create({
            organization_id: orgId,
            sequence_id: sequence.id,
            lead_id: lead.id,
            campaign_id: campaignId,
            initial_mail_id: initialMailId,
            initial_message_id: initialMessageId,
            initial_subject: initialSubject,
            initial_sent_at: initialSentAt,
            current_step: 1,
            total_steps: steps.length,
            status: "active",
        });

        const createdTasks = [];
        for (const step of steps) {
            const stepNum = Number(step.stepNumber || step.step_number);
            const dayOffset = Number(step.dayOffset !== undefined ? step.dayOffset : step.day_offset);
            const threadMode = step.threadMode || step.thread_mode || (stepNum === 1 || stepNum === 5 ? "REPLY_THREAD" : "NEW_THREAD");

            const scheduledAt = calculateScheduledDate(initialSentAt, dayOffset, {
                ...sequence,
                timezone: sequence.timezone || env.callingTimezone,
            });
            const content = await followUpContentService.generateStepContent(stepNum, lead, {
                subject: initialSubject,
                messageId: initialMessageId,
                senderName: initialContext.senderName,
                research: initialContext.research,
            });

            const inReplyTo = threadMode === "REPLY_THREAD" ? initialMessageId : null;

            const task = await FollowUpTask.create({
                organization_id: orgId,
                enrollment_id: enrollment.id,
                lead_id: lead.id,
                sequence_id: sequence.id,
                step_number: stepNum,
                day_offset: dayOffset,
                scheduled_at: scheduledAt,
                status: "SCHEDULED",
                thread_mode: threadMode,
                in_reply_to: inReplyTo,
                subject: content.subject,
                body_text: content.text,
                body_html: content.html,
                video_concept: content.videoConcept,
            });
            createdTasks.push(task);
        }

        const firstFollowUpAt = createdTasks[0]?.scheduled_at;
        if (firstFollowUpAt && lead.next_action !== "CALL") {
            await Lead.updateById(
                lead.id,
                {
                    next_action: "EMAIL",
                    next_action_time: firstFollowUpAt,
                },
                orgId
            );
        }

        await LeadEvent.create({
            organization_id: orgId,
            lead_id: lead.id,
            user_id: lead.user_id || null,
            channel: "EMAIL",
            event_type: "FOLLOW_UP_SCHEDULED",
            status: "SCHEDULED",
            payload: {
                enrollmentId: enrollment.id,
                sequenceId: sequence.id,
                totalSteps: steps.length,
                initialSentAt: initialSentAt.toISOString(),
                firstScheduledAt: createdTasks[0]?.scheduled_at,
                scheduledSteps: createdTasks.map((task) => ({
                    stepNumber: task.step_number,
                    dayOffset: task.day_offset,
                    scheduledAt: task.scheduled_at,
                })),
            },
            idempotency_key: `lead_${lead.id}_enroll_${enrollment.id}`,
        });

        return { enrollment, tasks: createdTasks };
    },

    async matchIncomingReply({ from, to = null, subject = "", messageId = null, inReplyTo = null, references = [], orgId = null }) {
        const cleanFrom = String(from || "").toLowerCase().trim();
        const cleanInReplyTo = inReplyTo ? String(inReplyTo).replace(/[<>]/g, "").trim() : null;

        const refList = Array.isArray(references)
            ? references.map((r) => String(r).replace(/[<>]/g, "").trim())
            : (typeof references === "string" ? [references.replace(/[<>]/g, "").trim()] : []);

        if (cleanInReplyTo) {
            const task = await FollowUpTask.findByMessageId(cleanInReplyTo, orgId);
            if (task) {
                const targetOrgId = orgId || task.organization_id || 1;
                const enrollment = await FollowUpEnrollment.findById(task.enrollment_id, targetOrgId);
                const lead = await Lead.findById(task.lead_id, targetOrgId);
                if (enrollment && lead) {
                    return { matched: true, lead, enrollment, task, matchedBy: "HEADER_IN_REPLY_TO" };
                }
            }

            const enrollSql = orgId
                ? `SELECT * FROM follow_up_enrollments WHERE (initial_message_id = ? OR initial_message_id LIKE ?) AND organization_id = ? LIMIT 1`
                : `SELECT * FROM follow_up_enrollments WHERE (initial_message_id = ? OR initial_message_id LIKE ?) LIMIT 1`;
            const enrollParams = orgId
                ? [cleanInReplyTo, `%${cleanInReplyTo}%`, orgId]
                : [cleanInReplyTo, `%${cleanInReplyTo}%`];

            const enrollmentsByMsg = await query(enrollSql, enrollParams);
            if (enrollmentsByMsg && enrollmentsByMsg.length > 0) {
                const enrollment = enrollmentsByMsg[0];
                const targetOrgId = orgId || enrollment.organization_id || 1;
                const lead = await Lead.findById(enrollment.lead_id, targetOrgId);
                if (lead) {
                    return { matched: true, lead, enrollment, task: null, matchedBy: "HEADER_IN_REPLY_TO_INITIAL" };
                }
            }
        }

        for (const ref of refList) {
            if (!ref) continue;
            const task = await FollowUpTask.findByMessageId(ref, orgId);
            if (task) {
                const targetOrgId = orgId || task.organization_id || 1;
                const enrollment = await FollowUpEnrollment.findById(task.enrollment_id, targetOrgId);
                const lead = await Lead.findById(task.lead_id, targetOrgId);
                if (enrollment && lead) {
                    return { matched: true, lead, enrollment, task, matchedBy: "HEADER_REFERENCES" };
                }
            }
        }

        if (cleanFrom) {
            const candidates = orgId
                ? await query(`SELECT * FROM leads WHERE LOWER(email) = ? AND (organization_id = ? OR organization_id IS NULL) ORDER BY id DESC`, [cleanFrom, orgId])
                : await query(`SELECT * FROM leads WHERE LOWER(email) = ? ORDER BY id DESC`, [cleanFrom]);

            if (candidates && candidates.length === 1) {
                const lead = candidates[0];
                const targetOrgId = orgId || lead.organization_id || 1;
                const enrollment = await FollowUpEnrollment.findActiveByLeadId(lead.id, targetOrgId);
                return { matched: true, lead, enrollment: enrollment || null, task: null, matchedBy: "SENDER_EMAIL" };
            }

            if (candidates && candidates.length > 1) {
                const withActive = [];
                for (const c of candidates) {
                    const targetOrgId = orgId || c.organization_id || 1;
                    const active = await FollowUpEnrollment.findActiveByLeadId(c.id, targetOrgId);
                    if (active) withActive.push({ lead: c, enrollment: active });
                }

                if (withActive.length === 1) {
                    return {
                        matched: true,
                        lead: withActive[0].lead,
                        enrollment: withActive[0].enrollment,
                        task: null,
                        matchedBy: "SENDER_EMAIL_ACTIVE_ENROLLMENT",
                    };
                }

                return {
                    matched: false,
                    ambiguous: true,
                    reason: "Multiple leads with identical email and active sequences",
                    candidateIds: candidates.map((c) => c.id),
                };
            }
        }

        return { matched: false, ambiguous: false, reason: "No matching lead found" };
    },

    async handleLeadReply(lead, replyPayload = {}, matchedEnrollment = null) {
        if (!lead || !lead.id) return null;
        const orgId = Number(lead.organization_id || 1);
        const enrollment = matchedEnrollment || await FollowUpEnrollment.findActiveByLeadId(lead.id, orgId);
        const outcome = resolveReplyOutcome(replyPayload.outcome);
        const replySubject = replyPayload.subject || "Reply received";
        const replyText = replyPayload.replyText || replyPayload.body || "";
        const messageId = replyPayload.messageId || null;

        if (!enrollment && (outcome === ASE_OUTCOMES.OOO || outcome === ASE_OUTCOMES.DNC || outcome === ASE_OUTCOMES.CALLBACK)) {
            return null;
        }

        if (enrollment && outcome === ASE_OUTCOMES.OOO) {
            await FollowUpEnrollment.markOutOfOffice(enrollment.id, { messageId, subject: replySubject, date: replyPayload.date }, orgId);
            await query(
                `UPDATE follow_up_tasks SET scheduled_at = DATE_ADD(scheduled_at, INTERVAL 5 DAY)
                 WHERE enrollment_id = ? AND organization_id = ? AND status = 'SCHEDULED'`,
                [enrollment.id, orgId]
            );

            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                user_id: lead.user_id || null,
                channel: "EMAIL",
                event_type: "FOLLOW_UP_PAUSED",
                status: "PAUSED",
                payload: {
                    enrollmentId: enrollment?.id || null,
                    reason: "Out-of-office response detected; sequence paused and tasks deferred by 5 days",
                    outcome: "OUTCOME_OOO",
                    messageId,
                },
                idempotency_key: `lead_${lead.id}_reply_ooo_${enrollment.id}_${messageId || Date.now()}`,
            });

            return { paused: true, status: "paused_out_of_office", enrollmentId: enrollment.id };
        }

        if (enrollment && outcome === ASE_OUTCOMES.DNC) {
            await FollowUpEnrollment.markDoNotContact(enrollment.id, "Prospect requested DNC / unsubscribe", orgId);
            await FollowUpTask.cancelRemaining(enrollment.id, "Prospect opted out / DNC", "CANCELLED", orgId);

            await Suppression.add(orgId, {
                email: lead.email,
                reason: "UNSUBSCRIBE_REPLY",
                created_by: "EmailReplyListener",
            });

            await Lead.updateById(lead.id, { do_not_contact: 1 }, orgId);

            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: "SYSTEM",
                event_type: "SUPPRESSION_APPLIED",
                status: "SUPPRESSED",
                payload: {
                    email: lead.email,
                    reason: "Prospect requested DNC / unsubscribe via email reply",
                },
                idempotency_key: `lead_${lead.id}_suppression_${messageId || Date.now()}`,
            });

            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                user_id: lead.user_id || null,
                channel: "EMAIL",
                event_type: "FOLLOW_UP_STOPPED",
                status: "CANCELLED",
                payload: {
                    enrollmentId: enrollment?.id || null,
                    reason: "Prospect requested DNC / unsubscribe; outreach terminated across all campaigns",
                    outcome: "OUTCOME_DNC",
                },
                idempotency_key: `lead_${lead.id}_stop_dnc_${enrollment.id}_${messageId || Date.now()}`,
            });

            return { stopped: true, status: "stopped_do_not_contact", enrollmentId: enrollment.id };
        }

        if (enrollment && outcome === ASE_OUTCOMES.CALLBACK) {
            await FollowUpEnrollment.markMeetingBooked(enrollment.id, orgId);
            await FollowUpTask.cancelRemaining(enrollment.id, "Sales meeting or call requested", "CANCELLED", orgId);

            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                user_id: lead.user_id || null,
                channel: "EMAIL",
                event_type: "FOLLOW_UP_STOPPED",
                status: "COMPLETED",
                payload: {
                    enrollmentId: enrollment?.id || null,
                    reason: "Sales call requested; promotional sequence stopped",
                    outcome: "OUTCOME_CALLBACK",
                },
                idempotency_key: `lead_${lead.id}_meeting_stop_${enrollment.id}_${messageId || Date.now()}`,
            });

            return { stopped: true, status: "stopped_meeting_booked", enrollmentId: enrollment.id };
        }

        if (enrollment) {
            await FollowUpEnrollment.markReplied(
                enrollment.id,
                { messageId, subject: replySubject, outcome, date: replyPayload.date },
                orgId
            );
            await FollowUpTask.blockRemainingForReply(enrollment.id, `Prospect reply received (${outcome})`, orgId);
        }

        let draft = null;
        let sent = null;
        const shouldReply = outcome !== ASE_OUTCOMES.DNC && outcome !== ASE_OUTCOMES.OOO;
        if (shouldReply) {
            draft = await followUpContentService.generateResponseDraft(lead, {
                subject: replySubject,
                replyText,
            }, {
                subject: enrollment?.initial_subject,
                senderName: env.novaSenderName || "NOVA AI",
                research: lead.metadata?.company_research,
            });

            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                user_id: lead.user_id || null,
                channel: "EMAIL",
                event_type: "AI_RESPONSE_DRAFTED",
                status: "DRAFT",
                payload: {
                    enrollmentId: enrollment?.id || null,
                    subject: draft.subject,
                    bodyText: draft.text,
                    bodyHtml: draft.html,
                },
                idempotency_key: `lead_${lead.id}_response_draft_${enrollment?.id || "none"}_${messageId || Date.now()}`,
            });

            if (!shouldSkipReplySend() && lead.email && draft?.subject && (draft.text || draft.html)) {
                try {
                    const headers = {};
                    if (messageId) {
                        headers["In-Reply-To"] = messageId;
                        headers["References"] = messageId;
                    }
                    const delivery = await unifiedDeliveryService.deliverSingle({
                        orgId,
                        to: lead.email,
                        subject: draft.subject,
                        text: draft.text,
                        html: draft.html,
                        headers,
                        leadId: lead.id,
                        idempotencyKey: `reply_response_${orgId}_${lead.id}_${messageId || Date.now()}`,
                    });
                    sent = delivery;
                    await LeadEvent.create({
                        organization_id: orgId,
                        lead_id: lead.id,
                        user_id: lead.user_id || null,
                        channel: "EMAIL",
                        event_type: delivery.status === "SUCCEEDED" ? "AI_RESPONSE_SENT" : "AI_RESPONSE_FAILED",
                        status: delivery.status === "SUCCEEDED" ? "SENT" : "FAILED",
                        payload: {
                            enrollmentId: enrollment?.id || null,
                            subject: draft.subject,
                            bodyText: draft.text,
                            bodyHtml: draft.html,
                            messageId: delivery.messageId || null,
                            error: delivery.error || delivery.skipReason || null,
                            replyTo: messageId,
                        },
                        idempotency_key: `lead_${lead.id}_response_sent_${enrollment?.id || "none"}_${messageId || Date.now()}`,
                    });
                } catch (err) {
                    await LeadEvent.create({
                        organization_id: orgId,
                        lead_id: lead.id,
                        channel: "EMAIL",
                        event_type: "AI_RESPONSE_FAILED",
                        status: "FAILED",
                        payload: { enrollmentId: enrollment?.id || null, subject: draft.subject, error: err.message },
                    }).catch(() => {});
                }
            }
        }

        if (enrollment) {
            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                user_id: lead.user_id || null,
                channel: "EMAIL",
                event_type: "FOLLOW_UP_PAUSED",
                status: "PAUSED",
                payload: {
                    enrollmentId: enrollment.id,
                    reason: `Prospect replied to outreach (${outcome}); automated follow-ups blocked pending review`,
                    replySubject,
                    outcome,
                    hasDraft: Boolean(draft),
                    sent: sent?.status === "SUCCEEDED",
                },
                idempotency_key: `lead_${lead.id}_reply_pause_${enrollment.id}_${messageId || Date.now()}`,
            });

            const io = getIo();
            if (io) {
                io.emit("followup:paused", {
                    leadId: lead.id,
                    enrollmentId: enrollment.id,
                    status: "paused_reply_received",
                    outcome,
                    hasDraft: Boolean(draft),
                    sent: sent?.status === "SUCCEEDED",
                });
            }
        }

        return {
            paused: Boolean(enrollment),
            status: enrollment ? "paused_reply_received" : "reply_handled",
            enrollmentId: enrollment?.id || null,
            draft,
            sent: sent?.status === "SUCCEEDED",
        };
    },

    async handleMeetingBooked(leadId, orgId = 1) {
        const enrollment = await FollowUpEnrollment.findActiveByLeadId(leadId, orgId);
        if (!enrollment) return;

        await FollowUpEnrollment.markMeetingBooked(enrollment.id, orgId);
        await FollowUpTask.cancelRemaining(enrollment.id, "Meeting booked", "CANCELLED", orgId);

        await LeadEvent.create({
            organization_id: orgId,
            lead_id: Number(leadId),
            channel: "SYSTEM",
            event_type: "FOLLOW_UP_STOPPED",
            status: "COMPLETED",
            payload: {
                enrollmentId: enrollment.id,
                reason: "Sales meeting booked; promotional follow-up sequence permanently stopped",
            },
            idempotency_key: `lead_${leadId}_meeting_stopped_${enrollment.id}`,
        });
    },

    async handleSuppression(leadId, orgId = 1, reason = "Compliance suppression / DNC activated") {
        const enrollment = await FollowUpEnrollment.findActiveByLeadId(leadId, orgId);
        if (!enrollment) return;

        await FollowUpEnrollment.markDoNotContact(enrollment.id, reason, orgId);
        await FollowUpTask.cancelRemaining(enrollment.id, reason, "CANCELLED", orgId);

        await LeadEvent.create({
            organization_id: orgId,
            lead_id: Number(leadId),
            channel: "SYSTEM",
            event_type: "FOLLOW_UP_STOPPED",
            status: "CANCELLED",
            payload: {
                enrollmentId: enrollment.id,
                reason,
            },
            idempotency_key: `lead_${leadId}_suppressed_stopped_${enrollment.id}`,
        });
    },

    async resumeLeadSequence(enrollmentId, user = {}, orgId = 1) {
        const enrollment = await FollowUpEnrollment.findById(enrollmentId, orgId);
        if (!enrollment) throw new Error("Enrollment not found");

        const terminalStates = new Set(["stopped_meeting_booked", "stopped_unsubscribed", "stopped_do_not_contact", "completed"]);
        if (terminalStates.has(enrollment.status)) {
            throw new Error(`Cannot resume sequence in terminal compliance state: ${enrollment.status}`);
        }

        const lead = await Lead.findById(enrollment.lead_id, orgId);
        if (!lead) throw new Error("Lead associated with enrollment not found");

        if (lead.do_not_contact) {
            throw new Error("Cannot resume: lead is marked Do Not Contact");
        }

        if (lead.status === "MEETING_BOOKED") {
            throw new Error("Cannot resume: sales meeting already booked for this lead");
        }

        const domain = lead.email ? lead.email.split("@")[1] : null;
        const suppressed = await Suppression.isSuppressed(orgId, { email: lead.email, domain });
        if (suppressed) {
            throw new Error("Cannot resume: recipient email is on active suppression list");
        }

        const updated = await FollowUpEnrollment.resume(enrollment.id, orgId, {
            resumedBy: user.email || user.name || "user",
            resumedReason: "Manual review completed and approved for continuation",
        });

        const blockedTasks = await FollowUpTask.findByEnrollmentId(enrollment.id, orgId);
        const now = new Date();
        for (const task of blockedTasks) {
            if (task.status === "BLOCKED_REPLY" || (task.status === "SCHEDULED" && new Date(task.scheduled_at) < now)) {
                const nextSlot = new Date(Date.now() + 60 * 60 * 1000);
                await FollowUpTask.updateById(task.id, {
                    status: "SCHEDULED",
                    scheduled_at: nextSlot,
                    last_error: null,
                }, orgId);
            }
        }

        await LeadEvent.create({
            organization_id: orgId,
            lead_id: lead.id,
            user_id: user.id || null,
            channel: "EMAIL",
            event_type: "FOLLOW_UP_RESUMED",
            status: "ACTIVE",
            payload: {
                enrollmentId: enrollment.id,
                resumedBy: user.email || "user",
                reason: "Sequence manually reviewed and resumed",
            },
        });

        return updated;
    },

    async stopLeadSequence(enrollmentId, reason = "Manually stopped", user = {}, orgId = 1) {
        const enrollment = await FollowUpEnrollment.findById(enrollmentId, orgId);
        if (!enrollment) throw new Error("Enrollment not found");

        const updated = await FollowUpEnrollment.updateById(enrollment.id, {
            status: "stopped_do_not_contact",
            paused_reason: reason,
            completed_at: new Date(),
        }, orgId);

        await FollowUpTask.cancelRemaining(enrollment.id, reason, "CANCELLED", orgId);

        await LeadEvent.create({
            organization_id: orgId,
            lead_id: enrollment.lead_id,
            user_id: user.id || null,
            channel: "EMAIL",
            event_type: "FOLLOW_UP_STOPPED",
            status: "CANCELLED",
            payload: {
                enrollmentId: enrollment.id,
                reason,
                stoppedBy: user.email || "user",
            },
        });

        return updated;
    },

    async markReplyProcessed(enrollmentId, user = {}, orgId = 1) {
        const enrollment = await FollowUpEnrollment.findById(enrollmentId, orgId);
        if (!enrollment) throw new Error("Enrollment not found");

        const updated = await FollowUpEnrollment.markReplyProcessed(enrollment.id, user, orgId);

        await LeadEvent.create({
            organization_id: orgId,
            lead_id: enrollment.lead_id,
            user_id: user.id || null,
            channel: "EMAIL",
            event_type: "REPLY_PROCESSED",
            status: "PROCESSED",
            payload: {
                enrollmentId: enrollment.id,
                processedBy: user.email || "user",
                replyMessageId: enrollment.reply_message_id,
            },
        });

        return updated;
    },

    async startAutomation({ orgId = 1, user = {} } = {}) {
        const id = Number(orgId || 1);
        const settings = await FollowUpAutomation.start(id, user);

        const sequences = await FollowUpSequence.list(id);
        for (const seq of sequences) {
            await FollowUpSequence.updateById(seq.id, { is_active: 1 }, id);
        }

        try {
            await eventBus.publish("FOLLOWUP_RESUMED", { organization_id: id, scope: "organization" });
        } catch (_) {}

        followUpScheduler.kick();
        return settings;
    },

    async pauseAutomation({ scope = "organization", id = null, reason = "Automation paused", user = {}, orgId = 1 } = {}) {
        const targetOrgId = Number(orgId || 1);

        if (scope === "lead") {
            const enrollment = await FollowUpEnrollment.findById(id, targetOrgId);
            if (!enrollment) throw new Error("Enrollment not found");
            const updated = await FollowUpEnrollment.pause(enrollment.id, reason, targetOrgId);
            await FollowUpTask.cancelRemaining(enrollment.id, reason, "CANCELLED", targetOrgId);
            await LeadEvent.create({
                organization_id: targetOrgId,
                lead_id: enrollment.lead_id,
                user_id: user.id || null,
                channel: "EMAIL",
                event_type: "FOLLOW_UP_PAUSED",
                status: "PAUSED",
                payload: { enrollmentId: enrollment.id, reason, pausedBy: user.email || "user", scope: "lead" },
            });
            return { scope: "lead", enrollment: updated };
        }

        if (scope === "sequence" || scope === "campaign") {
            const seqId = Number(id);
            await FollowUpSequence.updateById(seqId, { is_active: 0 }, targetOrgId);

            const enrollments = await query(
                `SELECT id, lead_id FROM follow_up_enrollments WHERE organization_id = ? AND sequence_id = ? AND (status = 'active' OR status = 'ACTIVE')`,
                [targetOrgId, seqId]
            );
            for (const row of enrollments) {
                await FollowUpEnrollment.updateById(row.id, { status: "paused_manual", paused_reason: reason }, targetOrgId);
                await LeadEvent.create({
                    organization_id: targetOrgId,
                    lead_id: row.lead_id,
                    user_id: user.id || null,
                    channel: "EMAIL",
                    event_type: "FOLLOW_UP_PAUSED",
                    status: "PAUSED",
                    payload: { enrollmentId: row.id, reason, pausedBy: user.email || "user", scope },
                });
            }
            return { scope, sequenceId: seqId, pausedEnrollments: enrollments.length };
        }

        const settings = await FollowUpAutomation.pause(targetOrgId, reason, user);
        try {
            await eventBus.publish("FOLLOWUP_PAUSED", { organization_id: targetOrgId, scope: "organization", reason });
        } catch (_) {}
        return { scope: "organization", settings };
    },

    async resumeAutomation({ scope = "organization", id = null, user = {}, orgId = 1 } = {}) {
        const targetOrgId = Number(orgId || 1);

        if (scope === "lead") {
            const resumed = await this.resumeLeadSequence(id, user, targetOrgId);
            followUpScheduler.kick();
            return { scope: "lead", enrollment: resumed };
        }

        if (scope === "sequence" || scope === "campaign") {
            const seqId = Number(id);
            await FollowUpSequence.updateById(seqId, { is_active: 1 }, targetOrgId);

            const pausedList = await query(
                `SELECT id FROM follow_up_enrollments WHERE organization_id = ? AND sequence_id = ? AND status = 'paused_manual'`,
                [targetOrgId, seqId]
            );
            let resumedCount = 0;
            for (const row of pausedList) {
                try {
                    await this.resumeLeadSequence(row.id, user, targetOrgId);
                    resumedCount++;
                } catch (_) {}
            }
            followUpScheduler.kick();
            return { scope, sequenceId: seqId, resumedEnrollments: resumedCount };
        }

        const settings = await FollowUpAutomation.resume(targetOrgId, user);
        const seqs = await FollowUpSequence.list(targetOrgId);
        for (const s of seqs) {
            await FollowUpSequence.updateById(s.id, { is_active: 1 }, targetOrgId);
        }

        const overdueTasks = await query(
            `SELECT id, step_number FROM follow_up_tasks WHERE organization_id = ? AND status = 'SCHEDULED' AND scheduled_at <= ? ORDER BY scheduled_at ASC`,
            [targetOrgId, new Date()]
        );

        const now = Date.now();
        for (let i = 0; i < overdueTasks.length; i++) {
            const task = overdueTasks[i];
            const staggeredDate = new Date(now + (i * 90 + 30) * 1000);
            await FollowUpTask.updateById(task.id, { scheduled_at: staggeredDate }, targetOrgId);
        }

        try {
            await eventBus.publish("FOLLOWUP_RESUMED", { organization_id: targetOrgId, scope: "organization" });
        } catch (_) {}

        followUpScheduler.kick();
        return { scope: "organization", settings, rescheduledCount: overdueTasks.length };
    },

    async stopAutomation({ scope = "organization", id = null, reason = "Automation stopped", user = {}, orgId = 1 } = {}) {
        const targetOrgId = Number(orgId || 1);

        if (scope === "lead") {
            const stopped = await this.stopLeadSequence(id, reason, user, targetOrgId);
            return { scope: "lead", enrollment: stopped };
        }

        if (scope === "sequence" || scope === "campaign") {
            const seqId = Number(id);
            await FollowUpSequence.updateById(seqId, { is_active: 0 }, targetOrgId);

            const enrollments = await query(
                `SELECT id, lead_id FROM follow_up_enrollments
                 WHERE organization_id = ? AND sequence_id = ?
                   AND status NOT IN ('completed', 'stopped_meeting_booked', 'stopped_unsubscribed', 'stopped_do_not_contact', 'stopped')`,
                [targetOrgId, seqId]
            );
            for (const row of enrollments) {
                await FollowUpEnrollment.updateById(row.id, {
                    status: "stopped",
                    paused_reason: reason,
                    completed_at: new Date(),
                }, targetOrgId);
                await FollowUpTask.cancelRemaining(row.id, reason, "CANCELLED", targetOrgId);
                await LeadEvent.create({
                    organization_id: targetOrgId,
                    lead_id: row.lead_id,
                    user_id: user.id || null,
                    channel: "EMAIL",
                    event_type: "FOLLOW_UP_STOPPED",
                    status: "CANCELLED",
                    payload: { enrollmentId: row.id, reason, stoppedBy: user.email || "user", scope },
                });
            }
            return { scope, sequenceId: seqId, stoppedEnrollments: enrollments.length };
        }

        const settings = await FollowUpAutomation.stop(targetOrgId, reason, user);
        await execute(`UPDATE follow_up_sequences SET is_active = 0 WHERE organization_id = ?`, [targetOrgId]);

        const allActive = await query(
            `SELECT id, lead_id FROM follow_up_enrollments
             WHERE organization_id = ?
               AND status NOT IN ('completed', 'stopped_meeting_booked', 'stopped_unsubscribed', 'stopped_do_not_contact', 'stopped')`,
            [targetOrgId]
        );
        for (const row of allActive) {
            await FollowUpEnrollment.updateById(row.id, {
                status: "stopped",
                paused_reason: reason,
                completed_at: new Date(),
            }, targetOrgId);
            await FollowUpTask.cancelRemaining(row.id, reason, "CANCELLED", targetOrgId);
            await LeadEvent.create({
                organization_id: targetOrgId,
                lead_id: row.lead_id,
                user_id: user.id || null,
                channel: "EMAIL",
                event_type: "FOLLOW_UP_STOPPED",
                status: "CANCELLED",
                payload: { enrollmentId: row.id, reason, stoppedBy: user.email || "user", scope: "organization" },
            });
        }

        try {
            await eventBus.publish("FOLLOWUP_STOPPED", { organization_id: targetOrgId, scope: "organization", reason });
        } catch (_) {}

        return { scope: "organization", settings, stoppedEnrollments: allActive.length };
    },

    async retryTask(taskId, orgId = 1) {
        const id = Number(taskId);
        const targetOrgId = Number(orgId || 1);
        const task = await FollowUpTask.findById(id, targetOrgId);
        if (!task) throw new Error("Task not found");
        const enrollment = await FollowUpEnrollment.findById(task.enrollment_id, targetOrgId);
        if (!enrollment || (enrollment.status !== "active" && enrollment.status !== "ACTIVE")) {
            throw new Error(`Cannot retry task: sequence is ${enrollment?.status || "inactive"}`);
        }
        const lead = await Lead.findById(task.lead_id, targetOrgId);
        if (!lead || lead.do_not_contact) {
            throw new Error("Cannot retry task: lead is marked Do Not Contact");
        }
        await FollowUpTask.updateById(task.id, {
            status: "SCHEDULED",
            scheduled_at: new Date(),
            last_error: null,
        }, targetOrgId);
        return FollowUpTask.findById(task.id, targetOrgId);
    },
};

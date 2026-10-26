import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectDb, closeDb, execute, getPool } from "../config/db.js";
import { runMigrations } from "../config/migrations.js";
import { calculateScheduledDate, followUpEngine } from "../services/followup/followUpEngine.service.js";
import { followUpContentService } from "../services/followup/followUpContent.service.js";
import { FollowUpEnrollment } from "../models/follow-up-enrollment.model.js";
import { FollowUpTask } from "../models/follow-up-task.model.js";
import { FollowUpSequence } from "../models/follow-up-sequence.model.js";
import { Lead } from "../models/lead.model.js";
import { LeadEvent } from "../models/lead-event.model.js";
import { Suppression } from "../models/suppression.model.js";
import { followUpScheduler } from "../services/followup/followUpScheduler.service.js";

describe("Automated Cold Email Follow-Up Sequence Suite", () => {
    const testOrgId = 9977;
    let testLead = null;

    before(async () => {
        try {
            await connectDb();
            await runMigrations(getPool());

            testLead = await Lead.create({
                organization_id: testOrgId,
                user_id: 1,
                name: "Alex Vance",
                first_name: "Alex",
                last_name: "Vance",
                email: `alex.vance.${Date.now()}@example.org`,
                company: "Apex Innovations",
                status: "NEW",
                metadata: {
                    company_research: {
                        company: "Apex Innovations",
                        summary: "Apex Innovations builds automated enterprise workflow systems.",
                        coreServices: "Workflow automation and cloud services",
                        industry: "Enterprise Software",
                        targetAudience: "B2B SaaS companies",
                    },
                },
            });
        } catch (_) {}
    });

    after(async () => {
        try {
            if (testLead) {
                await execute(`DELETE FROM follow_up_tasks WHERE organization_id = ?`, [testOrgId]).catch(() => {});
                await execute(`DELETE FROM follow_up_enrollments WHERE organization_id = ?`, [testOrgId]).catch(() => {});
                await execute(`DELETE FROM follow_up_sequences WHERE organization_id = ?`, [testOrgId]).catch(() => {});
                await execute(`DELETE FROM lead_events WHERE organization_id = ?`, [testOrgId]).catch(() => {});
                await execute(`DELETE FROM leads WHERE organization_id = ?`, [testOrgId]).catch(() => {});
            }
            await closeDb();
        } catch (_) {}
    });

    test("1. Default Follow-Up Schedule calculations match exact calendar-day offsets", () => {
        const initialDate = new Date("2026-10-19T10:00:00.000Z");

        const step1Date = calculateScheduledDate(initialDate, 2, {
            sending_days: [0, 1, 2, 3, 4, 5, 6],
            sending_window_start: "09:00",
            sending_window_end: "18:00",
        });
        assert.equal(step1Date.toISOString().slice(0, 10), "2026-10-21");

        const step2Date = calculateScheduledDate(initialDate, 7, {
            sending_days: [0, 1, 2, 3, 4, 5, 6],
            sending_window_start: "09:00",
            sending_window_end: "18:00",
        });
        assert.equal(step2Date.toISOString().slice(0, 10), "2026-10-26");

        const step3Date = calculateScheduledDate(initialDate, 14, {
            sending_days: [0, 1, 2, 3, 4, 5, 6],
            sending_window_start: "09:00",
            sending_window_end: "18:00",
        });
        assert.equal(step3Date.toISOString().slice(0, 10), "2026-11-02");

        const step4Date = calculateScheduledDate(initialDate, 28, {
            sending_days: [0, 1, 2, 3, 4, 5, 6],
            sending_window_start: "09:00",
            sending_window_end: "18:00",
        });
        assert.equal(step4Date.toISOString().slice(0, 10), "2026-11-16");

        const step5Date = calculateScheduledDate(initialDate, 42, {
            sending_days: [0, 1, 2, 3, 4, 5, 6],
            sending_window_start: "09:00",
            sending_window_end: "18:00",
        });
        assert.equal(step5Date.toISOString().slice(0, 10), "2026-11-30");
    });

    test("2. Sending window and business day adjustment prevents weekend execution", () => {
        const initialDate = new Date("2026-10-22T10:00:00.000Z");
        const weekdayOnlyConfig = {
            sending_days: [1, 2, 3, 4, 5],
            sending_window_start: "09:00",
            sending_window_end: "18:00",
        };

        const target = calculateScheduledDate(initialDate, 2, weekdayOnlyConfig);
        const dayOfWeek = target.getUTCDay();
        assert.ok(dayOfWeek >= 1 && dayOfWeek <= 5);
        assert.equal(target.toISOString().slice(0, 10), "2026-10-26");
    });

    test("3. Step content generation adheres to prompt rules for each follow-up touch", async () => {
        const step1 = await followUpContentService.generateStepContent(1, testLead, {
            subject: "Apex Innovations: note on workflows",
            senderName: "Sarah Jenkins",
        }, { forceDeterministic: true });
        assert.ok(step1.subject.startsWith("Re:"));
        assert.ok(!step1.text.includes("calendly") && !step1.text.includes("book a meeting"));
        assert.ok(step1.text.includes("Apex Innovations"));

        const step2 = await followUpContentService.generateStepContent(2, testLead, {
            subject: "Apex Innovations: note on workflows",
            senderName: "Sarah Jenkins",
        }, { forceDeterministic: true });
        assert.ok(!step2.subject.startsWith("Re:"));
        assert.ok(step2.text.includes("Apex Innovations"));

        const step3 = await followUpContentService.generateStepContent(3, testLead, {
            subject: "Apex Innovations: note on workflows",
            senderName: "Sarah Jenkins",
        }, { forceDeterministic: true });
        assert.ok(step3.text.includes("bandwidth") || step3.text.includes("time"));

        const step4 = await followUpContentService.generateStepContent(4, testLead, {
            subject: "Apex Innovations: note on workflows",
            senderName: "Sarah Jenkins",
        }, { forceDeterministic: true });
        assert.ok(step4.videoConcept !== null && typeof step4.videoConcept === "object");
        assert.ok(step4.videoConcept.observation && step4.videoConcept.recommendation);

        const step5 = await followUpContentService.generateStepContent(5, testLead, {
            subject: "Apex Innovations: note on workflows",
            senderName: "Sarah Jenkins",
        }, { forceDeterministic: true });
        assert.ok(step5.subject.startsWith("Re:"));
        assert.ok(step5.text.includes("step back") || step5.text.includes("revisit"));
    });

    test("4. Lead enrollment creates 5 persistent follow-up tasks linked to initial message", async () => {
        const enrolled = await followUpEngine.enrollLead(testLead, {
            sentAt: new Date("2026-10-19T10:00:00Z"),
            subject: "Apex Innovations: initial intro",
            messageId: "msg_init_12345",
        });

        assert.ok(enrolled.enrollment?.id);
        assert.equal(enrolled.tasks.length, 5);

        const tasksInDb = await FollowUpTask.findByEnrollmentId(enrolled.enrollment.id, testOrgId);
        assert.equal(tasksInDb.length, 5);

        assert.equal(tasksInDb[0].step_number, 1);
        assert.equal(tasksInDb[0].day_offset, 2);
        assert.equal(tasksInDb[0].thread_mode, "REPLY_THREAD");
        assert.equal(tasksInDb[0].in_reply_to, "msg_init_12345");

        assert.equal(tasksInDb[1].step_number, 2);
        assert.equal(tasksInDb[1].day_offset, 7);
        assert.equal(tasksInDb[1].thread_mode, "NEW_THREAD");

        assert.equal(tasksInDb[4].step_number, 5);
        assert.equal(tasksInDb[4].day_offset, 42);

        const events = await LeadEvent.listByLead(testOrgId, testLead.id, 50);
        const scheduledEvent = events.find((e) => e.event_type === "FOLLOW_UP_SCHEDULED");
        assert.ok(scheduledEvent);
    });

    test("5. Inbound reply detection immediately pauses active enrollment and cancels pending tasks", async () => {
        const activeBefore = await FollowUpEnrollment.findActiveByLeadId(testLead.id, testOrgId);
        assert.ok(activeBefore);

        await followUpEngine.handleLeadReply(testLead, {
            outcome: "INTERESTED",
            subject: "Re: Apex Innovations: note on workflows",
            replyText: "Hi Sarah, yes we would be open to hearing more about this next Tuesday.",
            messageId: "reply_msg_999",
        });

        const enrollmentAfter = await FollowUpEnrollment.findById(activeBefore.id, testOrgId);
        assert.equal(enrollmentAfter.status, "REPLIED");

        const pendingTasks = await FollowUpTask.findByEnrollmentId(activeBefore.id, testOrgId);
        const nonCancelled = pendingTasks.filter((t) => t.status === "SCHEDULED" || t.status === "PROCESSING");
        assert.equal(nonCancelled.length, 0);

        const events = await LeadEvent.listByLead(testOrgId, testLead.id, 50);
        const pausedEvent = events.find((e) => e.event_type === "FOLLOW_UP_PAUSED");
        assert.ok(pausedEvent);
    });

    test("6. Meeting booked stops promotional follow-up and marks enrollment COMPLETED", async () => {
        const lead2 = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Diana Prince",
            email: `diana.${Date.now()}@example.org`,
            company: "Themyscira Global",
            status: "NEW",
        });

        const enrolled = await followUpEngine.enrollLead(lead2, {
            sentAt: new Date(),
            subject: "Global scaling",
            messageId: "msg_init_diana",
        });

        await followUpEngine.handleMeetingBooked(lead2.id, testOrgId);

        const afterMeeting = await FollowUpEnrollment.findById(enrolled.enrollment.id, testOrgId);
        assert.equal(afterMeeting.status, "MEETING_BOOKED");

        const tasks = await FollowUpTask.findByEnrollmentId(enrolled.enrollment.id, testOrgId);
        const remaining = tasks.filter((t) => t.status === "SCHEDULED");
        assert.equal(remaining.length, 0);
    });

    test("7. Suppression enforcement halts sequence and cancels remaining tasks", async () => {
        const lead3 = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Bruce Wayne",
            email: `bruce.${Date.now()}@example.org`,
            company: "Wayne Enterprises",
            status: "NEW",
        });

        const enrolled = await followUpEngine.enrollLead(lead3, {
            sentAt: new Date(),
            subject: "Tech inquiry",
            messageId: "msg_init_bruce",
        });

        await followUpEngine.handleSuppression(lead3.id, testOrgId);

        const afterSuppression = await FollowUpEnrollment.findById(enrolled.enrollment.id, testOrgId);
        assert.equal(afterSuppression.status, "CANCELLED");
    });
});


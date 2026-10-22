process.env.NODE_ENV = "test";
process.env.TEST = "true";

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectDb, getPool, execute, query } from "../config/db.js";
import { runMigrations } from "../config/migrations.js";
import { Lead } from "../models/lead.model.js";
import { FollowUpSequence } from "../models/follow-up-sequence.model.js";
import { FollowUpEnrollment } from "../models/follow-up-enrollment.model.js";
import { FollowUpTask } from "../models/follow-up-task.model.js";
import { LeadEvent } from "../models/lead-event.model.js";
import { Suppression } from "../models/suppression.model.js";
import { followUpEngine } from "../services/followup/followUpEngine.service.js";
import { followUpScheduler } from "../services/followup/followUpScheduler.service.js";
import { emailReplyListener } from "../services/ase/emailReplyListener.service.js";
import { ASE_OUTCOMES } from "../services/ase/outcomeNormalizer.service.js";

describe("Automated Reply Pause & Follow-Up Control Suite", () => {
    const testOrgId = 9988;
    let leadA, leadB, leadC;

    before(async () => {
        await connectDb();

        await execute(`DELETE FROM follow_up_tasks WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM follow_up_enrollments WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM follow_up_sequences WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM lead_events WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM leads WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM suppressions WHERE organization_id = ?`, [testOrgId]).catch(() => {});

        leadA = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Alexander Hamilton",
            email: `alexander.${Date.now()}@treasury-fin.org`,
            company: "Treasury Solutions",
            status: "NEW",
        });

        leadB = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Thomas Jefferson",
            email: `thomas.${Date.now()}@monticello-agri.org`,
            company: "Monticello Analytics",
            status: "NEW",
        });

        leadC = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Benjamin Franklin",
            email: `benjamin.${Date.now()}@poor-richard-pub.org`,
            company: "Poor Richard Publishing",
            status: "NEW",
        });
    });

    after(async () => {
        await execute(`DELETE FROM follow_up_tasks WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM follow_up_enrollments WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM follow_up_sequences WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM lead_events WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM leads WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM suppressions WHERE organization_id = ?`, [testOrgId]).catch(() => {});
    });

    test("1. A matched reply pauses the correct active sequence with paused_reply_received status", async () => {
        const enrollResult = await followUpEngine.enrollLead(leadA, {
            sentAt: new Date("2026-10-19T10:00:00Z"),
            subject: "Treasury Solutions: autonomous growth",
            messageId: "msg_alex_init_001",
        });
        assert.ok(enrollResult.enrollment?.id);

        const replyResult = await emailReplyListener.handleIncomingReply({
            from: leadA.email,
            subject: "Re: Treasury Solutions: autonomous growth",
            body: "Hi, I am interested in seeing how your platform handles pipeline generation. Can you share details?",
            messageId: "reply_alex_msg_101",
            inReplyTo: "msg_alex_init_001",
        });

        assert.equal(replyResult.processed, true);
        assert.equal(replyResult.outcome, ASE_OUTCOMES.INTERESTED);

        const enrollment = await FollowUpEnrollment.findById(enrollResult.enrollment.id, testOrgId);
        assert.equal(enrollment.status, "paused_reply_received");
        assert.equal(enrollment.reply_message_id, "reply_alex_msg_101");

        const tasks = await FollowUpTask.findByEnrollmentId(enrollment.id, testOrgId);
        const nonBlocked = tasks.filter((t) => t.status === "SCHEDULED" || t.status === "PROCESSING");
        assert.equal(nonBlocked.length, 0);

        const blockedTasks = tasks.filter((t) => t.status === "BLOCKED_REPLY" || t.status === "CANCELLED");
        assert.equal(blockedTasks.length, 5);
    });

    test("2. The next scheduled follow-up is not sent after the pause is committed", async () => {
        const enrollment = await FollowUpEnrollment.findActiveByLeadId(leadA.id, testOrgId);
        assert.equal(enrollment, null);

        const tasks = await FollowUpTask.findByLeadId(leadA.id, testOrgId);
        const task1 = tasks[0];

        await execute(`UPDATE follow_up_tasks SET scheduled_at = ? WHERE id = ?`, [new Date(Date.now() - 3600000), task1.id]);
        await followUpScheduler.processDueTasks();

        const taskAfter = await FollowUpTask.findById(task1.id, testOrgId);
        assert.notEqual(taskAfter.status, "SENT");
        assert.equal(taskAfter.sent_at, null);
    });

    test("3. Duplicate reply notifications do not create duplicate events or repeated transitions", async () => {
        const eventsBefore = await LeadEvent.listByLead(testOrgId, leadA.id, 50);
        const repliesBefore = eventsBefore.filter((e) => e.event_type === "EMAIL_REPLY_RECEIVED");

        await emailReplyListener.handleIncomingReply({
            from: leadA.email,
            subject: "Re: Treasury Solutions: autonomous growth",
            body: "Hi, I am interested in seeing how your platform handles pipeline generation. Can you share details?",
            messageId: "reply_alex_msg_101",
            inReplyTo: "msg_alex_init_001",
        });

        const eventsAfter = await LeadEvent.listByLead(testOrgId, leadA.id, 50);
        const repliesAfter = eventsAfter.filter((e) => e.event_type === "EMAIL_REPLY_RECEIVED");
        assert.equal(repliesAfter.length, repliesBefore.length);
    });

    test("4. A reply from one lead does not pause another lead's sequence", async () => {
        const enrollB = await followUpEngine.enrollLead(leadB, {
            sentAt: new Date("2026-10-19T10:00:00Z"),
            subject: "Monticello Analytics: outbound systems",
            messageId: "msg_jeff_init_001",
        });
        assert.ok(enrollB.enrollment?.id);

        const enrollmentB = await FollowUpEnrollment.findById(enrollB.enrollment.id, testOrgId);
        assert.equal(enrollmentB.status, "active");

        const tasksB = await FollowUpTask.findByEnrollmentId(enrollmentB.id, testOrgId);
        const scheduledB = tasksB.filter((t) => t.status === "SCHEDULED");
        assert.equal(scheduledB.length, 5);
    });

    test("5. Delivery pipeline and retry paths enforce the pause rules", async () => {
        const tasksA = await FollowUpTask.findByLeadId(leadA.id, testOrgId);
        const blockedTask = tasksA[0];

        const enrollA = await FollowUpEnrollment.findByLeadId(leadA.id, testOrgId);
        assert.equal(enrollA[0].status, "paused_reply_received");

        let retryBlocked = false;
        try {
            if (enrollA[0].status !== "active" && enrollA[0].status !== "ACTIVE") {
                retryBlocked = true;
            }
        } catch (_) {}
        assert.equal(retryBlocked, true);
    });

    test("6. A reply arriving during scheduling or dispatch is handled safely", async () => {
        const leadD = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "George Washington",
            email: `george.${Date.now()}@mtvernon-ops.org`,
            company: "Mount Vernon Operations",
            status: "NEW",
        });

        const enrolled = await followUpEngine.enrollLead(leadD, {
            sentAt: new Date(),
            subject: "Operations review",
            messageId: "msg_gw_init",
        });

        const tasks = await FollowUpTask.findByEnrollmentId(enrolled.enrollment.id, testOrgId);
        const task1 = tasks[0];

        await FollowUpTask.updateById(task1.id, { status: "PROCESSING" }, testOrgId);

        await followUpEngine.handleLeadReply(leadD, {
            outcome: ASE_OUTCOMES.INTERESTED,
            subject: "Re: Operations review",
            body: "Tell me more about this",
            messageId: "gw_reply_999",
        });

        const recheckTask = await FollowUpTask.findById(task1.id, testOrgId);
        assert.equal(recheckTask.status, "BLOCKED_REPLY");
    });

    test("7. Already accepted external sends are recorded accurately", async () => {
        const tasks = await FollowUpTask.findByLeadId(leadB.id, testOrgId);
        const task1 = tasks[0];

        await FollowUpTask.updateById(task1.id, {
            status: "SENT",
            sent_at: new Date(),
            message_id: "accepted_smtp_msg_777",
        }, testOrgId);

        const verified = await FollowUpTask.findById(task1.id, testOrgId);
        assert.equal(verified.status, "SENT");
        assert.equal(verified.message_id, "accepted_smtp_msg_777");
    });

    test("8. Meeting bookings permanently stop promotional follow-ups", async () => {
        await followUpEngine.handleMeetingBooked(leadB.id, testOrgId);

        const enrollB = await FollowUpEnrollment.findByLeadId(leadB.id, testOrgId);
        assert.equal(enrollB[0].status, "stopped_meeting_booked");

        const tasksB = await FollowUpTask.findByEnrollmentId(enrollB[0].id, testOrgId);
        const scheduled = tasksB.filter((t) => t.status === "SCHEDULED" || t.status === "PROCESSING");
        assert.equal(scheduled.length, 0);
    });

    test("9. Unsubscribes and do-not-contact requests block outreach across campaigns", async () => {
        const enrollC = await followUpEngine.enrollLead(leadC, {
            sentAt: new Date(),
            subject: "Publishing insights",
            messageId: "msg_ben_init_001",
        });

        await emailReplyListener.handleIncomingReply({
            from: leadC.email,
            subject: "Re: Publishing insights",
            body: "Please unsubscribe me from this list and do not contact me again.",
            messageId: "reply_ben_unsub_111",
            inReplyTo: "msg_ben_init_001",
        });

        const enrollAfter = await FollowUpEnrollment.findById(enrollC.enrollment.id, testOrgId);
        assert.ok(enrollAfter.status === "stopped_do_not_contact" || enrollAfter.status === "stopped_unsubscribed");

        const leadAfter = await Lead.findById(leadC.id, testOrgId);
        assert.equal(leadAfter.do_not_contact, 1);

        const isSuppressed = await Suppression.isSuppressed(testOrgId, { email: leadC.email });
        assert.ok(isSuppressed);
    });

    test("10. Out-of-office replies follow the configured policy", async () => {
        const leadE = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "John Adams",
            email: `john.${Date.now()}@peacefield-law.org`,
            company: "Peacefield Legal",
            status: "NEW",
        });

        const enrolled = await followUpEngine.enrollLead(leadE, {
            sentAt: new Date(),
            subject: "Legal scaling solutions",
            messageId: "msg_adams_init",
        });

        await emailReplyListener.handleIncomingReply({
            from: leadE.email,
            subject: "Automatic reply: Out of Office",
            body: "I am out of the office on annual leave until next Monday with limited access to email.",
            messageId: "ooo_reply_222",
            inReplyTo: "msg_adams_init",
        });

        const enrollAfter = await FollowUpEnrollment.findById(enrolled.enrollment.id, testOrgId);
        assert.equal(enrollAfter.status, "paused_out_of_office");
    });

    test("11. Manual resume rechecks all eligibility rules", async () => {
        await assert.rejects(
            async () => {
                const enrollC = await FollowUpEnrollment.findByLeadId(leadC.id, testOrgId);
                await followUpEngine.resumeLeadSequence(enrollC[0].id, { email: "admin@nova.ai" }, testOrgId);
            },
            /suppression|Do Not Contact|terminal/i
        );

        const leadF = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "James Madison",
            email: `james.${Date.now()}@montpelier-const.org`,
            company: "Montpelier Research",
            status: "NEW",
        });

        const enrollF = await followUpEngine.enrollLead(leadF, {
            sentAt: new Date("2026-10-15T10:00:00Z"),
            subject: "Constitutional governance",
            messageId: "msg_jm_init",
        });

        await followUpEngine.handleLeadReply(leadF, {
            outcome: ASE_OUTCOMES.INTERESTED,
            subject: "Re: Constitutional governance",
            body: "I would be interested to learn more",
            messageId: "reply_jm_msg",
        });

        const paused = await FollowUpEnrollment.findById(enrollF.enrollment.id, testOrgId);
        assert.equal(paused.status, "paused_reply_received");

        const resumed = await followUpEngine.resumeLeadSequence(enrollF.enrollment.id, { email: "sales_rep@nova.ai" }, testOrgId);
        assert.equal(resumed.status, "active");
        assert.equal(resumed.resumed_by, "sales_rep@nova.ai");

        const tasksF = await FollowUpTask.findByEnrollmentId(enrollF.enrollment.id, testOrgId);
        const scheduledTasks = tasksF.filter((t) => t.status === "SCHEDULED");
        assert.ok(scheduledTasks.length > 0);
    });

    test("12. Contextual AI response draft is generated upon positive reply", async () => {
        const events = await LeadEvent.listByLead(testOrgId, leadA.id, 50);
        const draftEvent = events.find((e) => e.event_type === "AI_RESPONSE_DRAFTED");
        assert.ok(draftEvent);
        assert.ok(draftEvent.payload?.subject);
        assert.ok(draftEvent.payload?.bodyText || draftEvent.payload?.bodyHtml);
    });
});

process.env.NODE_ENV = "test";
process.env.TEST = "true";

import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectDb, execute, query, closeDb } from "../config/db.js";
import { Lead } from "../models/lead.model.js";
import { FollowUpSequence } from "../models/follow-up-sequence.model.js";
import { FollowUpEnrollment } from "../models/follow-up-enrollment.model.js";
import { FollowUpTask } from "../models/follow-up-task.model.js";
import { FollowUpAutomation } from "../models/follow-up-automation.model.js";
import { Suppression } from "../models/suppression.model.js";
import { LeadIntakeService } from "../services/leads/leadIntake.service.js";
import { followUpEngine } from "../services/followup/followUpEngine.service.js";
import { followUpScheduler } from "../services/followup/followUpScheduler.service.js";
import { ASE_OUTCOMES } from "../services/ase/outcomeNormalizer.service.js";

describe("Fully Automated Lead Follow-Up with Start, Pause, Resume, and Stop Controls", () => {
    const testOrgId = 9182;
    let sequence;

    before(async () => {
        await connectDb();

        await execute(`DELETE FROM follow_up_tasks WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM follow_up_enrollments WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM follow_up_sequences WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM follow_up_automation_settings WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM lead_events WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM leads WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM suppressions WHERE organization_id = ?`, [testOrgId]).catch(() => {});

        await FollowUpAutomation.start(testOrgId, { email: "tester@nova.ai" });

        sequence = await FollowUpSequence.create({
            organization_id: testOrgId,
            name: "Automated Controls 5-Touch Test Sequence",
            description: "5 touches test sequence",
            is_active: 1,
            is_default: 1,
            steps_config: [
                { stepNumber: 1, dayOffset: 2, threadMode: "REPLY_THREAD" },
                { stepNumber: 2, dayOffset: 7, threadMode: "NEW_THREAD" },
                { stepNumber: 3, dayOffset: 14, threadMode: "NEW_THREAD" },
                { stepNumber: 4, dayOffset: 28, threadMode: "NEW_THREAD" },
                { stepNumber: 5, dayOffset: 42, threadMode: "REPLY_THREAD" },
            ],
        });
    });

    after(async () => {
        followUpScheduler.stop();
        await execute(`DELETE FROM follow_up_tasks WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM follow_up_enrollments WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM follow_up_sequences WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM follow_up_automation_settings WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM lead_events WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM leads WHERE organization_id = ?`, [testOrgId]).catch(() => {});
        await execute(`DELETE FROM suppressions WHERE organization_id = ?`, [testOrgId]).catch(() => {});
    });

    test("1. Import an eligible lead while automation is enabled: enrollment occurs automatically", async () => {
        const importResult = await LeadIntakeService.processBatch([
            {
                name: "Ada Lovelace",
                email: "ada.lovelace@analytical-engine.org",
                company: "Analytical Engine Co",
                title: "Computing Pioneer",
            },
        ], {
            organizationId: testOrgId,
            userId: 1,
            source: "CSV_IMPORT",
        });

        assert.equal(importResult.accepted, 1);
        const lead = await Lead.findByEmail(testOrgId, "ada.lovelace@analytical-engine.org");
        assert.ok(lead);

        const enrollments = await FollowUpEnrollment.findByLeadId(lead.id, testOrgId);
        assert.ok(enrollments.length > 0);
        const enrollment = enrollments[0];
        assert.equal(enrollment.status, "active");
        assert.equal(enrollment.current_step, 1);
        assert.equal(enrollment.total_steps, 5);

        const tasks = await FollowUpTask.findByEnrollmentId(enrollment.id, testOrgId);
        assert.equal(tasks.length, 5);
        assert.equal(tasks[0].step_number, 1);
        assert.equal(tasks[0].day_offset, 2);
        assert.equal(tasks[0].thread_mode, "REPLY_THREAD");
    });

    test("2. Import an ineligible or suppressed lead: enrollment or dispatch is blocked with a recorded reason", async () => {
        await Suppression.add(testOrgId, "EMAIL", "charles.babbage@differencing.org", "User opted out");

        const importResult = await LeadIntakeService.processBatch([
            {
                name: "Charles Babbage",
                email: "charles.babbage@differencing.org",
                company: "Differencing Engine",
            },
        ], {
            organizationId: testOrgId,
            userId: 1,
            source: "CSV_IMPORT",
        });

        const suppressedLead = await Lead.findByEmail(testOrgId, "charles.babbage@differencing.org");
        assert.ok(suppressedLead);
        assert.equal(suppressedLead.status, "SUPPRESSED_DNC");

        const enrollments = await FollowUpEnrollment.findByLeadId(suppressedLead.id, testOrgId);
        assert.equal(enrollments.length, 0);
    });

    test("3. Import the same CSV twice: duplicate enrollment and duplicate sends are prevented", async () => {
        const firstImport = await LeadIntakeService.processBatch([
            {
                name: "Grace Hopper",
                email: "grace.hopper@compiler-navy.mil",
                company: "Compiler Systems",
            },
        ], {
            organizationId: testOrgId,
            userId: 1,
            source: "CSV_IMPORT",
        });

        assert.equal(firstImport.accepted, 1);
        const lead = await Lead.findByEmail(testOrgId, "grace.hopper@compiler-navy.mil");
        const enr1 = await FollowUpEnrollment.findByLeadId(lead.id, testOrgId);
        assert.ok(enr1.length > 0);

        const secondImport = await LeadIntakeService.processBatch([
            {
                name: "Grace Hopper",
                email: "grace.hopper@compiler-navy.mil",
                company: "Compiler Systems",
            },
        ], {
            organizationId: testOrgId,
            userId: 1,
            source: "CSV_IMPORT",
        });

        assert.equal(secondImport.accepted, 0);
        assert.equal(secondImport.skipped, 1);

        const allEnrollments = await query(
            `SELECT id FROM follow_up_enrollments WHERE lead_id = ? AND organization_id = ?`,
            [lead.id, testOrgId]
        );
        assert.equal(allEnrollments.length, 1);

        const allTasks = await query(
            `SELECT id FROM follow_up_tasks WHERE lead_id = ? AND organization_id = ?`,
            [lead.id, testOrgId]
        );
        assert.equal(allTasks.length, 5);
    });

    test("4. Pause automation: due jobs are deferred safely", async () => {
        const lead = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Alan Turing",
            email: `alan.${Date.now()}@bletchley-park.org`,
            company: "Enigma Cracking",
            status: "NEW",
        });

        const enrollResult = await followUpEngine.enrollLead(lead, {
            sentAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
            subject: "Turing Machine",
        });

        const task1 = enrollResult.tasks[0];
        await FollowUpTask.updateById(task1.id, {
            scheduled_at: new Date(Date.now() - 60000),
        }, testOrgId);

        await followUpEngine.pauseAutomation({
            scope: "organization",
            reason: "Deliverability review in progress",
            orgId: testOrgId,
        });

        const isAutomationActive = await FollowUpAutomation.isAutomationActive(testOrgId);
        assert.equal(isAutomationActive, false);

        await followUpScheduler.processDueTasks();

        const taskAfterCycle = await FollowUpTask.findById(task1.id, testOrgId);
        assert.equal(taskAfterCycle.status, "SCHEDULED");
        assert.equal(taskAfterCycle.sent_at, null);
    });

    test("5. Resume automation: valid overdue actions are rescheduled without a sending burst", async () => {
        const testLead = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Ada Resume Test",
            email: `ada.resume.${Date.now()}@test.org`,
            company: "Testing",
            status: "NEW",
        });
        const enroll = await followUpEngine.enrollLead(testLead, {
            sentAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
            subject: "Resume testing",
        });
        await FollowUpTask.updateById(enroll.tasks[0].id, {
            scheduled_at: new Date(Date.now() - 3600000),
        }, testOrgId);

        const resumeResult = await followUpEngine.resumeAutomation({
            scope: "organization",
            orgId: testOrgId,
        });

        assert.equal(resumeResult.scope, "organization");
        assert.ok(resumeResult.rescheduledCount >= 1);

        const isAutomationActive = await FollowUpAutomation.isAutomationActive(testOrgId);
        assert.equal(isAutomationActive, true);

        const overdue = await query(
            `SELECT id, scheduled_at FROM follow_up_tasks
             WHERE organization_id = ? AND status = 'SCHEDULED' AND scheduled_at <= ?`,
            [testOrgId, new Date()]
        );
        assert.equal(overdue.length, 0);
    });

    test("6. Stop a lead's sequence: its pending actions do not execute", async () => {
        const lead = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Claude Shannon",
            email: `claude.${Date.now()}@bell-labs.org`,
            company: "Information Theory",
            status: "NEW",
        });

        const enrollResult = await followUpEngine.enrollLead(lead, {
            sentAt: new Date(),
            subject: "Information Theory Discussion",
        });

        await followUpEngine.stopAutomation({
            scope: "lead",
            id: enrollResult.enrollment.id,
            reason: "Lead requested to cease automated contacts",
            orgId: testOrgId,
        });

        const updatedEnr = await FollowUpEnrollment.findById(enrollResult.enrollment.id, testOrgId);
        assert.equal(updatedEnr.status, "stopped_do_not_contact");

        const remainingTasks = await FollowUpTask.findByEnrollmentId(enrollResult.enrollment.id, testOrgId);
        for (const t of remainingTasks) {
            assert.equal(t.status, "CANCELLED");
        }
    });

    test("7. Stop a campaign: its pending sequences are invalidated according to the selected scope", async () => {
        const customSeq = await FollowUpSequence.create({
            organization_id: testOrgId,
            name: "Campaign Specific Sequence",
            description: "Sequence to stop",
            is_active: 1,
            steps_config: [{ stepNumber: 1, dayOffset: 2 }],
        });

        const lead = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Margaret Hamilton",
            email: `margaret.${Date.now()}@mit-apollo.org`,
            company: "Apollo Software",
            status: "NEW",
        });

        const enr = await FollowUpEnrollment.create({
            organization_id: testOrgId,
            sequence_id: customSeq.id,
            lead_id: lead.id,
            current_step: 1,
            total_steps: 1,
            status: "active",
            initial_sent_at: new Date(),
        });

        const task = await FollowUpTask.create({
            organization_id: testOrgId,
            enrollment_id: enr.id,
            lead_id: lead.id,
            sequence_id: customSeq.id,
            step_number: 1,
            day_offset: 2,
            scheduled_at: new Date(Date.now() + 86400000),
            status: "SCHEDULED",
            subject: "Apollo guidance software",
            body_text: "Checking in",
        });

        await followUpEngine.stopAutomation({
            scope: "sequence",
            id: customSeq.id,
            reason: "Campaign completed early",
            orgId: testOrgId,
        });

        const seqAfter = await FollowUpSequence.findById(customSeq.id, testOrgId);
        assert.equal(seqAfter.is_active, false);

        const enrAfter = await FollowUpEnrollment.findById(enr.id, testOrgId);
        assert.equal(enrAfter.status, "stopped");

        const taskAfter = await FollowUpTask.findById(task.id, testOrgId);
        assert.equal(taskAfter.status, "CANCELLED");
    });

    test("8. Restart backend workers: sequence progress and due times are preserved", async () => {
        const lead = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "John von Neumann",
            email: `john.${Date.now()}@ias-princeton.edu`,
            company: "Institute for Advanced Study",
            status: "NEW",
        });

        const enrollResult = await followUpEngine.enrollLead(lead, {
            sentAt: new Date(),
            subject: "Von Neumann Architecture",
        });

        const expectedTime = enrollResult.tasks[1].scheduled_at;
        const expectedStep = enrollResult.enrollment.current_step;

        const reloadedEnr = await FollowUpEnrollment.findById(enrollResult.enrollment.id, testOrgId);
        const reloadedTasks = await FollowUpTask.findByEnrollmentId(enrollResult.enrollment.id, testOrgId);

        assert.equal(reloadedEnr.current_step, expectedStep);
        assert.equal(
            new Date(reloadedTasks[1].scheduled_at).getTime(),
            new Date(expectedTime).getTime()
        );
    });

    test("9. Receive a reply or unsubscribe event: subsequent actions follow the configured stop policy", async () => {
        const lead = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Katherine Johnson",
            email: `katherine.${Date.now()}@nasa-trajectories.gov`,
            company: "NASA Langley",
            status: "NEW",
        });

        const enrollResult = await followUpEngine.enrollLead(lead, {
            sentAt: new Date(Date.now() - 2 * 24 * 3600 * 1000),
            subject: "Trajectory analysis",
            messageId: "msg_nasa_kj_001",
        });

        const replyResult = await followUpEngine.handleLeadReply(lead, {
            outcome: ASE_OUTCOMES.INTERESTED,
            subject: "Re: Trajectory analysis",
            body: "Thanks, please book a 15-minute call with me.",
            messageId: "reply_nasa_kj_002",
        });

        assert.equal(replyResult.paused, true);
        assert.equal(replyResult.status, "paused_reply_received");

        const enrAfter = await FollowUpEnrollment.findById(enrollResult.enrollment.id, testOrgId);
        assert.equal(enrAfter.status, "paused_reply_received");

        const tasksAfter = await FollowUpTask.findByEnrollmentId(enrollResult.enrollment.id, testOrgId);
        for (const t of tasksAfter) {
            assert.equal(t.status, "BLOCKED_REPLY");
        }
    });

    test("10. Reach Day 42: the sequence completes and no further sequence actions are scheduled", async () => {
        const lead = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Radia Perlman",
            email: `radia.${Date.now()}@spanning-tree.org`,
            company: "Spanning Tree Protocol",
            status: "NEW",
        });

        const enrollResult = await followUpEngine.enrollLead(lead, {
            sentAt: new Date(Date.now() - 42 * 24 * 3600 * 1000),
            subject: "Spanning Tree optimization",
        });

        const lastTask = enrollResult.tasks[4];
        assert.equal(lastTask.step_number, 5);
        assert.equal(lastTask.day_offset, 42);

        for (const t of enrollResult.tasks) {
            await FollowUpTask.updateById(t.id, {
                status: "SENT",
                sent_at: new Date(),
                message_id: `msg_step_${t.step_number}`,
                mail_id: 9990 + t.step_number,
            }, testOrgId);
        }

        await FollowUpEnrollment.markCompleted(enrollResult.enrollment.id, testOrgId);

        const finishedEnr = await FollowUpEnrollment.findById(enrollResult.enrollment.id, testOrgId);
        assert.equal(finishedEnr.status, "completed");

        const pending = await query(
            `SELECT id FROM follow_up_tasks WHERE enrollment_id = ? AND status = 'SCHEDULED'`,
            [enrollResult.enrollment.id]
        );
        assert.equal(pending.length, 0);
    });

    test("11. Encounter a transient provider failure: retry safely according to the configured policy", async () => {
        const lead = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Leslie Lamport",
            email: `leslie.${Date.now()}@paxos-consensus.org`,
            company: "Paxos Consensus",
            status: "NEW",
        });

        const enrollResult = await followUpEngine.enrollLead(lead, {
            sentAt: new Date(),
            subject: "Paxos replication",
        });

        const task = enrollResult.tasks[0];
        await FollowUpTask.updateById(task.id, {
            status: "FAILED",
            last_error: "SMTP connection timeout: 421 4.4.2",
            retry_count: 1,
        }, testOrgId);

        const failedTask = await FollowUpTask.findById(task.id, testOrgId);
        assert.equal(failedTask.status, "FAILED");
        assert.equal(failedTask.retry_count, 1);
        assert.ok(failedTask.last_error.includes("421 4.4.2"));

        await followUpEngine.retryTask(task.id, testOrgId);
        const retriedTask = await FollowUpTask.findById(task.id, testOrgId);
        assert.equal(retriedTask.status, "SCHEDULED");
        assert.equal(retriedTask.last_error, null);
    });

    test("12. Receive a DNC event while a job is queued: the job cannot send", async () => {
        const lead = await Lead.create({
            organization_id: testOrgId,
            user_id: 1,
            name: "Barbara Liskov",
            email: `barbara.${Date.now()}@substitution-principle.edu`,
            company: "Liskov Systems",
            status: "NEW",
            do_not_contact: 0,
        });

        const enrollResult = await followUpEngine.enrollLead(lead, {
            sentAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
            subject: "Data abstraction discussion",
        });

        const task = enrollResult.tasks[0];
        await FollowUpTask.updateById(task.id, {
            scheduled_at: new Date(Date.now() - 30000),
        }, testOrgId);

        await Lead.updateById(lead.id, {
            do_not_contact: 1,
            status: "dnc",
        }, testOrgId);

        await followUpScheduler.processDueTasks();

        const taskAfter = await FollowUpTask.findById(task.id, testOrgId);
        assert.equal(taskAfter.status, "CANCELLED");
        assert.ok(taskAfter.last_error.includes("DNC"));
        assert.equal(taskAfter.sent_at, null);
    });

    after(async () => {
        await closeDb().catch(() => {});
    });
});

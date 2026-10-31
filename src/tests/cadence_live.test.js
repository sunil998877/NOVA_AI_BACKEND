process.env.NODE_ENV = "test";
process.env.PLIVO_AUTH_ID = "";
process.env.PLIVO_AGENT_AUTH_ID = "";
process.env.PLIVO_AUTH_TOKEN = "";
process.env.PLIVO_AGENT_AUTH_TOKEN = "";
process.env.PLIVO_PHONE_NUMBER = "";
process.env.OPENAI_API_KEY = "";
process.env.ASE_OPENAI_API_KEY = "";
process.env.ASE_CADENCE_LOG_ML = "false";

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

const ORG = 9977;
let db;
let Lead;
let Call;
let CadenceEnrollment;
let CadenceStep;
let cadence;
let applyPlivoCallPayload;
let haltOutreachForLead;
let followUpEngine;
let seedOperatingMode;

const CLEAN_TABLES = [
    "follow_up_automation_settings",
    "ase_cadence_steps",
    "ase_cadence_enrollments",
    "ase_cadence_policies",
    "telephony_webhook_events",
    "calls",
    "callbacks",
    "ase_executions",
    "ase_approvals",
    "follow_up_tasks",
    "follow_up_enrollments",
    "lead_events",
    "suppressions",
    "leads",
];

async function cleanup() {
    for (const table of CLEAN_TABLES) {
        await db.execute(`DELETE FROM ${table} WHERE organization_id = ?`, [ORG]).catch(() => {});
    }
}

let phoneSeq = 0;

async function makeLead(tag, extra = {}) {
    phoneSeq += 1;
    const phone = `+91900000${String(1000 + phoneSeq).padStart(4, "0")}`;
    return Lead.create({
        organization_id: ORG,
        user_id: null,
        name: `Rahul ${tag}`,
        first_name: "Rahul",
        email: `cadence.${tag}.${Date.now()}@example.com`,
        company: `Acme ${tag} Logistics`,
        phone,
        phone_e164: phone,
        phone_validation: "VALID",
        voice_consent: { status: "GRANTED" },
        email_consent: { status: "GRANTED" },
        status: "NEW",
        ...extra,
    });
}

async function steps(enrollmentId) {
    return CadenceStep.listByEnrollment(ORG, enrollmentId);
}

async function stepByKey(enrollmentId, key) {
    return CadenceStep.findByKey(enrollmentId, key);
}

async function makeDue(step) {
    await db.execute("UPDATE ase_cadence_steps SET due_at = ? WHERE id = ?", [new Date(Date.now() - 1000), step.id]);
}

async function fakeDial(step, uuid) {
    const { call } = await Call.create({
        organization_id: ORG,
        lead_id: step.lead_id,
        idempotency_key: `cadence_step_${step.id}`,
        provider_call_uuid: uuid,
        phone_number: "+919000000001",
        provider_status: "initiated",
        normalized_outcome: "INITIATED",
    });
    await db.execute("UPDATE ase_cadence_steps SET status = 'AWAITING_OUTCOME', call_id = ?, executed_at = ? WHERE id = ?", [call.id, new Date(), step.id]);
    return call;
}

describe("Smart cadence end-to-end (live DB, simulated providers)", () => {
    before(async () => {
        db = await import("../config/db.js");
        await db.connectDb();
        ({ Lead } = await import("../models/lead.model.js"));
        ({ Call } = await import("../models/call.model.js"));
        ({ CadenceEnrollment, CadenceStep } = await import("../models/ase-cadence.model.js"));
        cadence = await import("../services/ase/cadence/cadence.service.js");
        ({ applyPlivoCallPayload } = await import("../services/ase/voiceOutcomeApply.service.js"));
        ({ haltOutreachForLead } = await import("../services/ase/outreachHalt.service.js"));
        ({ followUpEngine } = await import("../services/followup/followUpEngine.service.js"));
        ({ seedOperatingMode } = await import("../services/ase/operatingMode.service.js"));
        seedOperatingMode(ORG, "FULLY_AUTOMATED");
        await cleanup();
        const allDay = { startHour: 0, endHour: 24, days: [0, 1, 2, 3, 4, 5, 6] };
        await cadence.savePolicy(ORG, { name: "Test 24x7", settings: { callingWindow: allDay, emailWindow: allDay }, isDefault: true });
    });

    after(async () => {
        await cleanup();
        await db.closeDb();
    });

    test("eligibility: unknown consent needs confirmation, suppressed lead is refused", async () => {
        const noConsent = await makeLead("noconsent", { voice_consent: null });
        const result = await cadence.enrollLead(ORG, noConsent.id, { actorId: 1 });
        assert.equal(result.enrolled, false);
        assert.equal(result.requiresConfirmation, true);
        assert.ok(result.eligibility.reasons.some((r) => r.code === "VOICE_CONSENT_MISSING"));

        const dnc = await makeLead("dnc", { do_not_contact: 1 });
        await assert.rejects(() => cadence.enrollLead(ORG, dnc.id, { actorId: 1 }), (err) => err.status === 409);
    });

    test("parallel enroll requests create exactly one enrollment and one first step", async () => {
        const lead = await makeLead("parallel");
        const results = await Promise.all([1, 2, 3].map(() => cadence.enrollLead(ORG, lead.id, { actorId: 1 })));
        assert.equal(results.filter((r) => r.enrolled).length, 1);
        const open = await CadenceEnrollment.findOpenByLead(ORG, lead.id);
        const list = await steps(open.id);
        assert.equal(list.length, 1);
        assert.equal(list[0].step_key, "call:1");
        const fresh = await Lead.findById(lead.id, ORG);
        assert.equal(fresh.next_action, "CADENCE");
    });

    test("no answer -> one retry; webhook no-answer on retry -> one missed-call email; duplicates and late events ignored", async () => {
        const lead = await makeLead("noanswer");
        const enrolled = await cadence.enrollLead(ORG, lead.id, { actorId: 1, startNow: true });
        assert.equal(enrolled.enrolled, true);
        const enrollmentId = enrolled.enrollment.id;

        const [first] = enrolled.steps;
        const [r1, r2] = await Promise.all([cadence.executeStep(ORG, first.id), cadence.executeStep(ORG, first.id)]);
        assert.equal([r1, r2].filter((r) => r.executed).length, 1, "only one worker may execute a step");

        const call1 = await stepByKey(enrollmentId, "call:1");
        assert.equal(call1.status, "DONE");
        assert.equal(call1.channel_state, "NO_ANSWER");
        const retry = await stepByKey(enrollmentId, "call:2");
        assert.ok(retry, "retry scheduled");
        assert.equal(retry.purpose, "RETRY_CALL");
        assert.ok(new Date(retry.due_at).getTime() >= Date.now() + 115 * 60 * 1000, "retry is ~2h later or aligned to calling hours");
        assert.equal(await stepByKey(enrollmentId, "email:missed_call"), null, "no email after first attempt");

        const uuid = `test-${Date.now()}`;
        const call = await fakeDial(retry, uuid);
        const payload = { CallUUID: uuid, CallStatus: "no-answer", orgId: ORG, callId: call.id, HangupCause: "NO_ANSWER" };
        await applyPlivoCallPayload(payload);
        const dup = await applyPlivoCallPayload(payload);
        assert.equal(dup.status, "duplicate_ignored");

        const missed = await stepByKey(enrollmentId, "email:missed_call");
        assert.ok(missed, "missed-call email scheduled");
        assert.equal(missed.purpose, "MISSED_CALL");
        const emailSteps = (await steps(enrollmentId)).filter((s) => s.action === "EMAIL");
        assert.equal(emailSteps.length, 1);

        await applyPlivoCallPayload({ CallUUID: uuid, CallStatus: "completed", orgId: ORG, callId: call.id, Duration: 40, AnswerTime: new Date().toISOString() });
        const after = (await steps(enrollmentId)).filter((s) => s.action === "EMAIL");
        assert.equal(after.length, 1, "late answered event must not create touches");
        const enrollment = await CadenceEnrollment.findById(ORG, enrollmentId);
        assert.equal(enrollment.status, "ACTIVE");
        assert.equal(enrollment.call_attempts, 1, "simulated call:1 counted; webhook-driven retry counted by executor only");

        await makeDue(missed);
        const pending = await cadence.executeStep(ORG, missed.id);
        assert.equal(pending.pendingApproval, true, "manual approval mode holds the email");
        const held = await CadenceStep.findById(ORG, missed.id);
        assert.equal(held.status, "PENDING_APPROVAL");
        assert.match(held.draft.text, /(tried|attempted) (calling|to call|to reach)/i);
        assert.equal((held.draft.text.match(/Best regards/g) || []).length, 1);
        assert.doesNotMatch(held.draft.text, /as discussed|great speaking|our conversation/i);
        assert.equal(held.draft.grounding, "conservative");

        await assert.rejects(
            () => cadence.approveEmailStep(ORG, missed.id, 1, { text: "Hi Rahul, great speaking with you earlier. As we discussed, here are details." }),
            (err) => err.status === 422
        );
        const approved = await cadence.approveEmailStep(ORG, missed.id, 1, {});
        assert.equal(approved.status, "SCHEDULED");
        await makeDue(approved);
        const sent = await cadence.executeStep(ORG, missed.id);
        assert.equal(sent.outcome, "SENT");
        const done = await CadenceStep.findById(ORG, missed.id);
        assert.equal(done.status, "DONE");
        assert.equal(done.channel_state, "SENT");
        const day3 = await stepByKey(enrollmentId, "day3_email");
        assert.ok(day3, "Day 3 value email planned after the missed-call email");
        assert.equal(day3.status, "SCHEDULED");

        const replied = await followUpEngine.handleLeadReply(await Lead.findById(lead.id, ORG), { outcome: "OUTCOME_INTERESTED", subject: "Re: Tried to reach you", replyText: "Sure, call me Monday", messageId: `m-${Date.now()}` });
        assert.ok(replied !== undefined);
        const paused = await CadenceEnrollment.findById(ORG, enrollmentId);
        assert.equal(paused.status, "REPLIED");
        assert.equal((await stepByKey(enrollmentId, "day3_email")).status, "CANCELLED");
        assert.equal((await Lead.findById(lead.id, ORG)).next_action === "CADENCE", false);

        const resumed = await cadence.resumeCadence(ORG, lead.id, 1, "Rep asked to continue");
        assert.equal(resumed.status, "ACTIVE");
        const revived = await stepByKey(enrollmentId, "day3_email");
        assert.equal(revived.status, "SCHEDULED");

        await cadence.pauseCadence(ORG, lead.id, 1, "Manual pause");
        await makeDue(revived);
        const deferred = await cadence.executeStep(ORG, revived.id);
        assert.equal(deferred.deferred, true, "paused cadence does not execute");
        await cadence.stopCadence(ORG, lead.id, 1, "Manual stop");
        assert.equal((await CadenceEnrollment.findById(ORG, enrollmentId)).status, "STOPPED");
        assert.equal((await stepByKey(enrollmentId, "day3_email")).status, "CANCELLED");
    });

    test("answered interested call hands off and never sends a missed-call email", async () => {
        const lead = await makeLead("interested");
        const { enrollment, steps: [first] } = await cadence.enrollLead(ORG, lead.id, { actorId: 1, startNow: true });
        const call = await fakeDial(first, `int-${Date.now()}`);
        const result = await cadence.handleCallEvent({
            orgId: ORG,
            call,
            callStatus: "completed",
            normalized: { normalizedOutcome: "OUTCOME_INTERESTED", isAnswered: true, disposition: "interested" },
            isFinal: true,
        });
        assert.equal(result.result, "INTERESTED");
        const fresh = await CadenceEnrollment.findById(ORG, enrollment.id);
        assert.equal(fresh.status, "HANDOFF");
        const list = await steps(enrollment.id);
        assert.equal(list.some((s) => s.action === "EMAIL"), false);
        assert.equal(list.filter((s) => s.action === "CALL").length, 1);
    });

    test("DNC halt stops the cadence and a late outcome cannot reopen it", async () => {
        const lead = await makeLead("halt");
        const { enrollment, steps: [first] } = await cadence.enrollLead(ORG, lead.id, { actorId: 1, startNow: true });
        const call = await fakeDial(first, `halt-${Date.now()}`);
        await haltOutreachForLead(ORG, lead.id, "Prospect requested DNC");
        const stopped = await CadenceEnrollment.findById(ORG, enrollment.id);
        assert.equal(stopped.status, "STOPPED");
        await cadence.handleCallEvent({ orgId: ORG, call, callStatus: "no-answer", normalized: { normalizedOutcome: "OUTCOME_NO_ANSWER", isAnswered: false }, isFinal: true });
        const after = await CadenceEnrollment.findById(ORG, enrollment.id);
        assert.equal(after.status, "STOPPED");
        const list = await steps(enrollment.id);
        assert.equal(list.length, 1, "no retry created after stop");
    });

    test("queue filters return the right rows", async () => {
        const pending = await cadence.listQueue(ORG, { filter: "email_pending_approval" });
        assert.ok(Array.isArray(pending.items));
        const all = await cadence.listQueue(ORG, {});
        assert.ok(Array.isArray(all.items));
        await assert.rejects(() => cadence.listQueue(ORG, { filter: "nope" }), (err) => err.status === 400);
    });
});

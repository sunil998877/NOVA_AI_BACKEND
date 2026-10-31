import { test } from "node:test";
import assert from "node:assert/strict";
import {
    classifyCallResult,
    decideAfterCall,
    decideAfterEmail,
    evaluateLeadEligibility,
    normalizeCadenceSettings,
    planFirstStep,
    planNextFollowUp,
    precheckStep,
} from "../services/ase/cadence/cadencePolicy.js";
import { alignToWindow, zonedParts } from "../services/ase/cadence/cadenceTime.js";
import { CALL_RESULT, ELIGIBILITY, ENROLLMENT_STATUS } from "../services/ase/cadence/cadence.constants.js";
import { findConversationClaims, validateEmailDraft } from "../services/ase/emailQuality.service.js";

const TZ = "Asia/Kolkata";
const MONDAY_11_IST = new Date("2026-11-02T05:30:00.000Z");
const { settings } = normalizeCadenceSettings({});
const channels = { call: true, email: true };

function enrollment(extra = {}) {
    return { id: 1, status: "ACTIVE", call_attempts: 1, email_attempts: 0, started_at: MONDAY_11_IST, flags: {}, ...extra };
}

function eligibleLead(extra = {}) {
    return {
        id: 7,
        status: "NEW",
        first_name: "Rahul",
        company: "Acme Logistics",
        email: "rahul@acmelogistics.in",
        phone: "+919876543210",
        phone_e164: "+919876543210",
        phone_validation: "VALID",
        voice_consent: { status: "GRANTED" },
        email_consent: { status: "GRANTED" },
        do_not_contact: 0,
        ...extra,
    };
}

function minutesBetween(a, b) {
    return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

test("defaults match the brief: 1 retry after 2h, busy 4h, email 30m, manual approval", () => {
    assert.equal(settings.firstAction, "CALL");
    assert.equal(settings.maxInitialCallAttempts, 2);
    assert.equal(settings.retryIntervalMinutes, 120);
    assert.equal(settings.busyRetryIntervalMinutes, 240);
    assert.equal(settings.emailAfterRetryDelayMinutes, 30);
    assert.equal(settings.emailApprovalMode, "MANUAL");
    assert.deepEqual(settings.followUpSteps.map((s) => s.day), [3, 5, 8, 12, 17]);
});

test("settings are clamped and invalid values are reported, not silently trusted", () => {
    const { settings: s, errors } = normalizeCadenceSettings({
        retryIntervalMinutes: 1,
        maxInitialCallAttempts: 99,
        voicemailAction: "SING",
        timezone: "Mars/Base",
        callingWindow: { startHour: 20, endHour: 9, days: [1] },
    });
    assert.equal(s.retryIntervalMinutes, 15);
    assert.equal(s.maxInitialCallAttempts, 5);
    assert.equal(s.voicemailAction, "EMAIL");
    assert.equal(s.timezone, null);
    assert.ok(errors.some((e) => e.includes("voicemailAction")));
    assert.ok(errors.some((e) => e.includes("timezone")));
    assert.ok(errors.some((e) => e.includes("callingWindow")));
});

test("eligibility: complete lead with granted consent is Eligible", () => {
    const verdict = evaluateLeadEligibility(eligibleLead(), { settings });
    assert.equal(verdict.result, ELIGIBILITY.ELIGIBLE);
    assert.deepEqual(verdict.channels, { call: true, email: true });
});

test("eligibility: missing country code or unknown consent is Needs Review, never assumed", () => {
    const noCountry = evaluateLeadEligibility(eligibleLead({ phone: "9876543210", phone_e164: null, phone_validation: "MISSING_COUNTRY" }), { settings });
    assert.equal(noCountry.result, ELIGIBILITY.NEEDS_REVIEW);
    assert.ok(noCountry.reasons.some((r) => r.code === "PHONE_COUNTRY_MISSING"));

    const unknownVoice = evaluateLeadEligibility(eligibleLead({ voice_consent: { status: "UNKNOWN" } }), { settings });
    assert.equal(unknownVoice.result, ELIGIBILITY.NEEDS_REVIEW);
    assert.equal(unknownVoice.channels.call, false);

    const unknownEmail = evaluateLeadEligibility(eligibleLead({ email_consent: null }), { settings });
    assert.equal(unknownEmail.result, ELIGIBILITY.ELIGIBLE);
    assert.equal(unknownEmail.channels.email, false);
});

test("eligibility: DNC, suppression and terminal states are Suppressed", () => {
    assert.equal(evaluateLeadEligibility(eligibleLead({ do_not_contact: 1 }), { settings }).result, ELIGIBILITY.SUPPRESSED);
    assert.equal(evaluateLeadEligibility(eligibleLead(), { settings, suppressed: true }).result, ELIGIBILITY.SUPPRESSED);
    assert.equal(evaluateLeadEligibility(eligibleLead({ status: "CLOSED_LOST" }), { settings }).result, ELIGIBILITY.SUPPRESSED);
});

test("classification maps provider outcomes, and invalid numbers are not No Answer", () => {
    assert.equal(classifyCallResult({ normalizedOutcome: "OUTCOME_NO_ANSWER" }), CALL_RESULT.NO_ANSWER);
    assert.equal(classifyCallResult({ normalizedOutcome: "OUTCOME_RING_TIMEOUT" }), CALL_RESULT.NO_ANSWER);
    assert.equal(classifyCallResult({ normalizedOutcome: "OUTCOME_BUSY" }), CALL_RESULT.BUSY);
    assert.equal(classifyCallResult({ normalizedOutcome: "OUTCOME_VOICEMAIL" }), CALL_RESULT.VOICEMAIL);
    assert.equal(classifyCallResult({ normalizedOutcome: "OUTCOME_DNC" }), CALL_RESULT.OPT_OUT);
    assert.equal(classifyCallResult({ normalizedOutcome: "OUTCOME_CALLBACK" }), CALL_RESULT.CALLBACK_REQUESTED);
    assert.equal(classifyCallResult({ normalizedOutcome: "OUTCOME_INTERESTED", disposition: "meeting_booked" }), CALL_RESULT.MEETING_REQUESTED);
    assert.equal(classifyCallResult({ normalizedOutcome: "OUTCOME_FAILED", hangupCause: "UNALLOCATED_NUMBER" }), CALL_RESULT.INVALID_NUMBER);
    assert.equal(classifyCallResult({ normalizedOutcome: "OUTCOME_FAILED", hangupCause: "NETWORK_ERROR" }), CALL_RESULT.FAILED);
    assert.equal(classifyCallResult({ normalizedOutcome: "OUTCOME_AMBIGUOUS", isAnswered: true }), CALL_RESULT.FOLLOW_UP_REQUIRED);
});

test("first No Answer creates exactly one retry ~2h later inside calling hours", () => {
    const plan = decideAfterCall({ settings, step: { step_key: "call:1" }, enrollment: enrollment(), result: CALL_RESULT.NO_ANSWER, now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(plan.status, ENROLLMENT_STATUS.ACTIVE);
    assert.equal(plan.newSteps.length, 1);
    assert.equal(plan.newSteps[0].stepKey, "call:2");
    assert.equal(minutesBetween(MONDAY_11_IST, plan.newSteps[0].dueAt), 120);
});

test("second No Answer/Busy creates exactly one missed-call email after the configured delay", () => {
    for (const result of [CALL_RESULT.NO_ANSWER, CALL_RESULT.BUSY]) {
        const plan = decideAfterCall({ settings, step: { step_key: "call:2" }, enrollment: enrollment({ call_attempts: 2 }), result, now: MONDAY_11_IST, timezone: TZ, channels });
        assert.equal(plan.newSteps.length, 1, result);
        assert.equal(plan.newSteps[0].stepKey, "email:missed_call");
        assert.equal(minutesBetween(MONDAY_11_IST, plan.newSteps[0].dueAt), 30);
    }
});

test("Busy uses the longer configurable interval, not an immediate retry", () => {
    const plan = decideAfterCall({ settings, step: { step_key: "call:1" }, enrollment: enrollment(), result: CALL_RESULT.BUSY, now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(plan.newSteps[0].stepKey, "call:2");
    assert.equal(minutesBetween(MONDAY_11_IST, plan.newSteps[0].dueAt), 240);
});

test("retry disabled skips straight to the email; a retry landing after hours moves to the next window", () => {
    const { settings: noRetry } = normalizeCadenceSettings({ retryEnabled: false });
    const plan = decideAfterCall({ settings: noRetry, step: { step_key: "call:1" }, enrollment: enrollment(), result: CALL_RESULT.NO_ANSWER, now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(plan.newSteps[0].stepKey, "email:missed_call");

    const evening = new Date("2026-11-02T13:00:00.000Z");
    const late = decideAfterCall({ settings, step: { step_key: "call:1" }, enrollment: enrollment(), result: CALL_RESULT.NO_ANSWER, now: evening, timezone: TZ, channels });
    const parts = zonedParts(late.newSteps[0].dueAt, TZ);
    assert.equal(parts.hour, 9);
    assert.equal(parts.weekday, 2);
});

test("voicemail follows the campaign voicemail policy", () => {
    const email = decideAfterCall({ settings, step: { step_key: "call:1" }, enrollment: enrollment(), result: CALL_RESULT.VOICEMAIL, now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(email.newSteps[0].stepKey, "email:missed_call");

    const { settings: retry } = normalizeCadenceSettings({ voicemailAction: "RETRY" });
    assert.equal(decideAfterCall({ settings: retry, step: { step_key: "call:1" }, enrollment: enrollment(), result: CALL_RESULT.VOICEMAIL, now: MONDAY_11_IST, timezone: TZ, channels }).newSteps[0].stepKey, "call:2");

    const { settings: review } = normalizeCadenceSettings({ voicemailAction: "HUMAN_REVIEW" });
    const reviewed = decideAfterCall({ settings: review, step: { step_key: "call:1" }, enrollment: enrollment(), result: CALL_RESULT.VOICEMAIL, now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(reviewed.status, ENROLLMENT_STATUS.NEEDS_REVIEW);
    assert.equal(reviewed.newSteps[0].action, "HUMAN_REVIEW");
});

test("answered calls never enter the missed-call email path", () => {
    const answered = [
        CALL_RESULT.INTERESTED,
        CALL_RESULT.MEETING_REQUESTED,
        CALL_RESULT.CALLBACK_REQUESTED,
        CALL_RESULT.NEEDS_INFORMATION,
        CALL_RESULT.FOLLOW_UP_REQUIRED,
        CALL_RESULT.NOT_INTERESTED,
        CALL_RESULT.OPT_OUT,
    ];
    for (const result of answered) {
        for (const stepKey of ["call:1", "call:2", "day5_call"]) {
            const plan = decideAfterCall({ settings, step: { step_key: stepKey }, enrollment: enrollment(), result, now: MONDAY_11_IST, timezone: TZ, channels });
            assert.equal(plan.newSteps.some((s) => s.action === "EMAIL"), false, `${result} on ${stepKey}`);
            assert.equal(plan.newSteps.some((s) => s.action === "CALL"), false, `${result} on ${stepKey}`);
            assert.equal(plan.cancelOpen, true, `${result} on ${stepKey}`);
        }
    }
});

test("interested hands off, callback pauses, not-interested and opt-out stop", () => {
    const run = (result) => decideAfterCall({ settings, step: { step_key: "call:1" }, enrollment: enrollment(), result, now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(run(CALL_RESULT.INTERESTED).status, ENROLLMENT_STATUS.HANDOFF);
    assert.equal(run(CALL_RESULT.CALLBACK_REQUESTED).status, ENROLLMENT_STATUS.CALLBACK);
    assert.equal(run(CALL_RESULT.NOT_INTERESTED).status, ENROLLMENT_STATUS.STOPPED);
    const optOut = run(CALL_RESULT.OPT_OUT);
    assert.equal(optOut.status, ENROLLMENT_STATUS.STOPPED);
    assert.equal(optOut.flags.optedOut, true);
});

test("invalid number is flagged for correction: no retry and no missed-call email by default", () => {
    const plan = decideAfterCall({ settings, step: { step_key: "call:1" }, enrollment: enrollment(), result: CALL_RESULT.INVALID_NUMBER, now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(plan.status, ENROLLMENT_STATUS.NEEDS_REVIEW);
    assert.equal(plan.flags.invalidPhone, true);
    assert.equal(plan.newSteps.length, 0);

    const { settings: allow } = normalizeCadenceSettings({ allowEmailAfterFailedCall: true });
    const allowed = decideAfterCall({ settings: allow, step: { step_key: "call:1" }, enrollment: enrollment(), result: CALL_RESULT.INVALID_NUMBER, now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(allowed.newSteps[0].stepKey, "email:missed_call");
    assert.equal(allowed.flags.invalidPhone, true);
});

test("without email permission the missed-call email is skipped and cadence moves on", () => {
    const plan = decideAfterCall({ settings, step: { step_key: "call:2" }, enrollment: enrollment({ call_attempts: 2 }), result: CALL_RESULT.NO_ANSWER, now: MONDAY_11_IST, timezone: TZ, channels: { call: true, email: false } });
    assert.equal(plan.newSteps[0].stepKey, "day5_call");
});

test("subsequent cadence: missed-call email sent -> Day 3, Day 5 no answer -> Day 8, bounce skips emails", () => {
    const afterMissed = decideAfterEmail({ settings, step: { step_key: "email:missed_call" }, enrollment: enrollment({ email_attempts: 1 }), outcome: "SENT", now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(afterMissed.newSteps[0].stepKey, "day3_email");
    assert.equal(zonedParts(afterMissed.newSteps[0].dueAt, TZ).day, 5);

    const afterDay5 = decideAfterCall({ settings, step: { step_key: "day5_call" }, enrollment: enrollment({ call_attempts: 3 }), result: CALL_RESULT.NO_ANSWER, now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(afterDay5.newSteps[0].stepKey, "day8_email");

    const bounced = decideAfterEmail({ settings, step: { step_key: "email:missed_call" }, enrollment: enrollment(), outcome: "BOUNCED", now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(bounced.flags.emailUndeliverable, true);
    assert.equal(bounced.newSteps[0].stepKey, "day5_call");
});

test("cadence completes when no permitted touches remain", () => {
    const plan = planNextFollowUp({ settings, enrollment: enrollment(), afterKey: "day17_close", now: MONDAY_11_IST, timezone: TZ, channels });
    assert.equal(plan.next, null);
    const done = decideAfterEmail({ settings, step: { step_key: "day8_email" }, enrollment: enrollment({ call_attempts: 4 }), outcome: "SENT", now: MONDAY_11_IST, timezone: TZ, channels: { call: true, email: true } });
    assert.equal(done.newSteps[0].action, "HUMAN_REVIEW");
});

test("first step: user-triggered call is immediate inside hours, but never outside calling hours", () => {
    const sunday = new Date("2026-11-01T05:30:00.000Z");
    const policy = planFirstStep({ settings, now: sunday, timezone: TZ, channels });
    assert.equal(policy.stepKey, "call:1");
    assert.equal(zonedParts(policy.dueAt, TZ).weekday, 1);
    const immediateOutside = planFirstStep({ settings, now: sunday, timezone: TZ, channels, immediate: true });
    assert.equal(immediateOutside.outsideWindow, true);
    assert.equal(zonedParts(immediateOutside.dueAt, TZ).weekday, 1);
    const immediateInside = planFirstStep({ settings, now: MONDAY_11_IST, timezone: TZ, channels, immediate: true });
    assert.equal(immediateInside.dueAt.getTime(), MONDAY_11_IST.getTime());
    assert.equal(planFirstStep({ settings, now: sunday, timezone: TZ, channels: { call: false } }), null);
});

test("human review steps run while the enrollment is in NEEDS_REVIEW", () => {
    const verdict = precheckStep({
        step: { action: "HUMAN_REVIEW", step_key: "review:answered_1" },
        enrollment: enrollment({ status: "NEEDS_REVIEW" }),
        lead: eligibleLead({ status: "CONTACTED" }),
        settings,
        now: MONDAY_11_IST,
        timezone: TZ,
    });
    assert.equal(verdict.proceed, true);
});

test("pre-execution re-check blocks stale steps", () => {
    const step = { action: "CALL", step_key: "call:2" };
    const lead = eligibleLead({ status: "CONTACTED" });
    const run = (extra) => precheckStep({ step, enrollment: enrollment(), lead, settings, now: MONDAY_11_IST, timezone: TZ, ...extra });
    assert.equal(run({}).proceed, true);
    assert.equal(run({ replySinceStep: true }).verdict, "REPLIED");
    assert.equal(run({ openCallback: true }).verdict, "HANDOFF");
    assert.equal(run({ lead: { ...lead, do_not_contact: 1 } }).verdict, "STOP");
    assert.equal(run({ lead: { ...lead, status: "INTERESTED" } }).verdict, "HANDOFF");
    assert.equal(run({ enrollment: enrollment({ status: "PAUSED" }) }).verdict, "DEFER");
    assert.equal(run({ enrollment: enrollment({ status: "STOPPED" }) }).verdict, "CANCEL");
    assert.equal(run({ enrollment: enrollment({ call_attempts: 4 }) }).verdict, "SKIP");
    assert.equal(run({ enrollment: enrollment({ flags: { invalidPhone: true } }) }).verdict, "SKIP");
    const night = run({ now: new Date("2026-11-02T16:30:00.000Z") });
    assert.equal(night.verdict, "RESCHEDULE");
    assert.equal(zonedParts(night.dueAt, TZ).hour, 9);
    assert.equal(precheckStep({ step: { action: "EMAIL" }, enrollment: enrollment({ flags: { emailUndeliverable: true } }), lead, settings, now: MONDAY_11_IST, timezone: TZ }).verdict, "SKIP");
});

test("window alignment skips weekends and respects the lead timezone", () => {
    const saturday = new Date("2026-11-07T06:00:00.000Z");
    const aligned = alignToWindow(saturday, settings.callingWindow, TZ);
    const parts = zonedParts(aligned, TZ);
    assert.equal(parts.weekday, 1);
    assert.equal(parts.hour, 9);
    const ny = alignToWindow(new Date("2026-11-02T05:30:00.000Z"), settings.callingWindow, "America/New_York");
    assert.equal(zonedParts(ny, "America/New_York").hour, 9);
});

test("missed-call email must not imply a conversation took place", () => {
    const bad = validateEmailDraft({ subject: "Following up", text: "Hi Rahul, great speaking with you earlier. As we discussed, here is more.", noPriorConversation: true });
    assert.equal(bad.eligibleToSend, false);
    assert.ok(bad.issues.includes("IMPLIES_PRIOR_CONVERSATION"));
    assert.ok(findConversationClaims("Per our call yesterday").length > 0);

    const good = validateEmailDraft({ subject: "Tried to reach you", text: "Hi Rahul, I tried calling you today but could not reach you. Would a short call next week help?", noPriorConversation: true });
    assert.equal(good.eligibleToSend, true);
});

test("near-identical copy to a previous touch is flagged", () => {
    const previous = "Hi Rahul, I wanted to share how we help logistics teams plan dispatch faster with less manual work.";
    const verdict = validateEmailDraft({ subject: "Checking in", text: previous, previousBodies: [previous] });
    assert.ok(verdict.issues.includes("NEAR_DUPLICATE"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { transitionLeadState } from "../services/ase/leadStateMachine.js";
import {
    AFTER_NO_RESPONSE,
    HEALTH,
    ILLEGAL_STATUS,
    MAX_CALLS,
    MAX_EMAILS,
} from "../services/ase/lifecycle.constants.js";
import {
    computeHealth,
    engineMayContact,
    evaluateCapsExhaust,
    evaluateQuietClose,
    isOutreachStopped,
    readLifecycleConfig,
    sanitizeNextAction,
    sanitizeStatus,
    schedulerWouldDispatch,
} from "../services/ase/lifecycle.service.js";

test("illegal ATTEMPTED status maps to CONTACTED and never stays as next_action", () => {
    assert.equal(ILLEGAL_STATUS, "ATTEMPTED");
    assert.equal(sanitizeStatus("ATTEMPTED"), "CONTACTED");
    assert.equal(sanitizeNextAction("ATTEMPTED"), "WAIT");
    const moved = transitionLeadState("ATTEMPTED", "NO_RESPONSE");
    assert.equal(moved.nextState, "NO_RESPONSE");
    assert.notEqual(moved.nextState, "ATTEMPTED");
});

test("3 email + 2 call with no reply is caps exhausted", () => {
    assert.equal(MAX_EMAILS, 3);
    assert.equal(MAX_CALLS, 2);
    const caps = evaluateCapsExhaust({ attempt_counters: { email: 3, voice: 2, total: 5 } });
    assert.equal(caps.exhausted, true);
    assert.equal(evaluateCapsExhaust({ attempt_counters: { email: 2, voice: 2 } }).exhausted, false);
});

test("org config after no-response is CLOSED_LOST or re-engage pool", () => {
    const lost = readLifecycleConfig({ lifecycle: { afterNoResponse: "CLOSED_LOST", quietDays: 21 } });
    const pool = readLifecycleConfig({ lifecycle: { afterNoResponse: "re-engage", afterQuietDays: "POOL" } });
    assert.equal(lost.afterNoResponse, AFTER_NO_RESPONSE.CLOSED_LOST);
    assert.equal(lost.quietDays, 21);
    assert.equal(pool.afterNoResponse, AFTER_NO_RESPONSE.RE_ENGAGEMENT_POOL);
    assert.equal(pool.afterQuietDays, AFTER_NO_RESPONSE.RE_ENGAGEMENT_POOL);
});

test("N quiet days flags auto-close unless the lead is a hot callback", () => {
    const stale = evaluateQuietClose({
        status: "CONTACTED",
        last_contacted_at: new Date(Date.now() - 15 * 86400000),
    }, { quietDays: 14 });
    const hot = evaluateQuietClose({
        status: "CALLBACK_SCHEDULED",
        last_contacted_at: new Date(Date.now() - 30 * 86400000),
    }, { quietDays: 14, hasOverdueCallback: true });
    assert.equal(stale.quiet, true);
    assert.equal(hot.quiet, false);
});

test("health is RED on overdue hot callback, AMBER near caps, GREEN otherwise", () => {
    assert.equal(computeHealth({ status: "CONTACTED" }, { overdueHotCallback: true }), HEALTH.RED);
    assert.equal(computeHealth({
        status: "CONTACTED",
        attempt_counters: { email: 2, voice: 1 },
    }), HEALTH.AMBER);
    assert.equal(computeHealth({
        status: "NEW",
        attempt_counters: { email: 0, voice: 0 },
        created_at: new Date(),
    }), HEALTH.GREEN);
});

test("Closed/DNC lead cannot be emailed or called by the scheduler", () => {
    for (const status of ["CLOSED_WON", "CLOSED_LOST", "CLOSED_UNQUALIFIED", "SUPPRESSED_DNC"]) {
        assert.equal(isOutreachStopped({ status, do_not_contact: 0 }), true);
        assert.equal(engineMayContact({ status }, "EMAIL").allowed, false);
        assert.equal(engineMayContact({ status }, "CALL").allowed, false);
        assert.equal(schedulerWouldDispatch({ status, next_action: "EMAIL" }, "EMAIL"), false);
        assert.equal(schedulerWouldDispatch({ status, next_action: "CALL" }, "CALL"), false);
    }
    const dnc = { status: "CONTACTED", do_not_contact: 1, next_action: "EMAIL" };
    assert.equal(engineMayContact(dnc, "EMAIL").allowed, false);
    assert.equal(schedulerWouldDispatch(dnc, "EMAIL"), false);
    assert.equal(schedulerWouldDispatch(dnc, "CALL"), false);
});

test("caps exhausted and quiet days also stop autonomous EMAIL/CALL", () => {
    const fatigued = {
        status: "CONTACTED",
        do_not_contact: 0,
        attempt_counters: { email: 3, voice: 2, total: 5 },
        next_action: "EMAIL",
    };
    const quiet = {
        status: "CONTACTED",
        do_not_contact: 0,
        last_contacted_at: new Date(Date.now() - 20 * 86400000),
        next_action: "CALL",
    };
    assert.equal(schedulerWouldDispatch(fatigued, "EMAIL", { autonomous: true }), false);
    assert.equal(schedulerWouldDispatch(quiet, "CALL", { autonomous: true }), false);
    assert.equal(schedulerWouldDispatch({
        status: "CONTACTED",
        do_not_contact: 0,
        attempt_counters: { email: 1, voice: 0 },
        last_contacted_at: new Date(),
        next_action: "EMAIL",
    }, "EMAIL", { autonomous: true }), true);
});

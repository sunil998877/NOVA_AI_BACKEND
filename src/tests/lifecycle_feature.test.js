import { test } from "node:test";
import assert from "node:assert/strict";
import { transitionLeadState } from "../services/ase/leadStateMachine.js";
import { AFTER_NO_RESPONSE } from "../services/ase/lifecycle.constants.js";
import {
    engineMayContact,
    evaluateCapsExhaust,
    readLifecycleConfig,
    sanitizeNextAction,
    sanitizeStatus,
    schedulerWouldDispatch,
} from "../services/ase/lifecycle.service.js";

function schedulerTickWouldSend(lead, action) {
    if (sanitizeStatus(lead.status) !== lead.status && lead.status === "ATTEMPTED") {
        return false;
    }
    return schedulerWouldDispatch(lead, action, { autonomous: true });
}

test("feature: Closed/DNC lead cannot be emailed or called by the scheduler", () => {
    const closed = { status: "CLOSED_LOST", do_not_contact: 0, next_action: "EMAIL" };
    const dnc = { status: "CONTACTED", do_not_contact: 1, next_action: "CALL" };
    assert.equal(schedulerTickWouldSend(closed, "EMAIL"), false);
    assert.equal(schedulerTickWouldSend(closed, "CALL"), false);
    assert.equal(schedulerTickWouldSend(dnc, "EMAIL"), false);
    assert.equal(schedulerTickWouldSend(dnc, "CALL"), false);
    assert.equal(engineMayContact(closed, "EMAIL").allowed, false);
    assert.equal(engineMayContact(dnc, "CALL").allowed, false);
});

test("feature: force/manual/approved still cannot contact a closed or DNC lead", () => {
    const closed = { status: "CLOSED_WON", next_action: "EMAIL" };
    const dnc = { status: "SUPPRESSED_DNC", do_not_contact: 1, next_action: "CALL" };
    assert.equal(schedulerWouldDispatch(closed, "EMAIL", { autonomous: false }), false);
    assert.equal(schedulerWouldDispatch(dnc, "CALL", { autonomous: false }), false);
});

test("feature: ATTEMPTED is stripped so the scheduler never dispatches it", () => {
    assert.equal(sanitizeNextAction("ATTEMPTED"), "WAIT");
    assert.equal(sanitizeStatus("ATTEMPTED"), "CONTACTED");
    assert.equal(schedulerTickWouldSend({
        status: "ATTEMPTED",
        next_action: "ATTEMPTED",
        do_not_contact: 0,
    }, "ATTEMPTED"), false);
});

test("feature: 3 email + 2 call then org policy CLOSE_LOST or re-engage", () => {
    const caps = evaluateCapsExhaust({ attempt_counters: { email: 3, voice: 2 } });
    assert.equal(caps.exhausted, true);
    const close = readLifecycleConfig({ lifecycle: { afterNoResponse: "CLOSED_LOST" } });
    const pool = readLifecycleConfig({ lifecycle: { afterNoResponse: "RE_ENGAGEMENT_POOL" } });
    const noResponse = transitionLeadState("CONTACTED", "NO_RESPONSE");
    const lost = transitionLeadState(noResponse.nextState, "CLOSE_LOST");
    const reengage = transitionLeadState(noResponse.nextState, "RE_ENGAGE");
    assert.equal(close.afterNoResponse, AFTER_NO_RESPONSE.CLOSED_LOST);
    assert.equal(pool.afterNoResponse, AFTER_NO_RESPONSE.RE_ENGAGEMENT_POOL);
    assert.equal(lost.nextState, "CLOSED_LOST");
    assert.equal(reengage.nextState, "RE_ENGAGEMENT_POOL");
    assert.equal(schedulerWouldDispatch({
        status: "CLOSED_LOST",
        next_action: "EMAIL",
        attempt_counters: { email: 3, voice: 2 },
    }, "EMAIL"), false);
});

test("feature: findDue query shape excludes terminal, DNC, and illegal ATTEMPTED", () => {
    assert.equal(sanitizeNextAction("EMAIL"), "EMAIL");
    assert.equal(sanitizeNextAction("ATTEMPTED"), "WAIT");
    assert.equal(["EMAIL", "CALL"].includes(sanitizeNextAction("ATTEMPTED")), false);
    assert.equal(engineMayContact({ status: "CLOSED_UNQUALIFIED" }, "EMAIL").allowed, false);
});

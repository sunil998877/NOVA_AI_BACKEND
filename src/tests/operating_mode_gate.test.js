import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDispatch, OPERATING_MODES } from "../services/ase/operatingMode.service.js";
import { nextHoldUntil, HOLD_DURATION_MS } from "../services/ase/approvalQueue.service.js";

function schedulerWouldSend(action, options) {
    return evaluateDispatch(action, options).allowed === true;
}

test("scheduler never sends EMAIL/CALL in AI-Recommended until approved", () => {
    assert.equal(
        schedulerWouldSend("EMAIL", { mode: OPERATING_MODES.AI_RECOMMENDED }),
        false
    );
    assert.equal(
        schedulerWouldSend("CALL", { mode: OPERATING_MODES.AI_RECOMMENDED }),
        false
    );
    assert.equal(
        schedulerWouldSend("CALL", { mode: OPERATING_MODES.AI_RECOMMENDED, approved: true }),
        true
    );
});

test("Execute Now force flag is not a send bypass in AI-Recommended or Human Escalation", () => {
    const ai = evaluateDispatch("EMAIL", { mode: OPERATING_MODES.AI_RECOMMENDED });
    const human = evaluateDispatch("CALL", { mode: OPERATING_MODES.HUMAN_ESCALATION });
    assert.equal(ai.allowed, false);
    assert.equal(ai.enqueue, true);
    assert.equal(human.allowed, false);
    assert.equal(human.enqueue, false);
});

test("Fully Automated still dispatches EMAIL and CALL without an approval row", () => {
    assert.equal(schedulerWouldSend("EMAIL", { mode: OPERATING_MODES.FULLY_AUTOMATED }), true);
    assert.equal(schedulerWouldSend("CALL", { mode: OPERATING_MODES.FULLY_AUTOMATED }), true);
});

test("Hold pushes the next touch 24 hours so the scheduler will not pick the lead as due", () => {
    const from = new Date("2026-10-27T00:00:00.000Z");
    const heldUntil = nextHoldUntil(from);
    assert.equal(heldUntil.getTime() - from.getTime(), HOLD_DURATION_MS);
    assert.equal(heldUntil > from, true);
});

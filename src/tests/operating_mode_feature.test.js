import { test } from "node:test";
import assert from "node:assert/strict";
import {
    OPERATING_MODES,
    evaluateDispatch,
    executionFlagsForMode,
} from "../services/ase/operatingMode.service.js";
import { nextHoldUntil, HOLD_DURATION_MS } from "../services/ase/approvalQueue.service.js";

function gate(action, mode, extras = {}) {
    return evaluateDispatch(action, { mode, ...extras });
}

test("feature: Fully Automated auto-sends EMAIL/CALL; Execute Now only skips timing", () => {
    assert.equal(gate("EMAIL", OPERATING_MODES.FULLY_AUTOMATED).allowed, true);
    assert.equal(gate("CALL", OPERATING_MODES.FULLY_AUTOMATED).enqueue, false);
    const flags = executionFlagsForMode(OPERATING_MODES.FULLY_AUTOMATED, { humanInitiated: true });
    assert.deepEqual(flags, { force: true, approved: false, manual: false });
});

test("feature: AI-Recommended never auto-sends; only approved:true can send", () => {
    const auto = gate("EMAIL", OPERATING_MODES.AI_RECOMMENDED);
    assert.equal(auto.allowed, false);
    assert.equal(auto.enqueue, true);

    const executeNow = gate("CALL", OPERATING_MODES.AI_RECOMMENDED);
    assert.equal(executeNow.allowed, false);

    const approved = gate("CALL", OPERATING_MODES.AI_RECOMMENDED, { approved: true });
    assert.equal(approved.allowed, true);
    assert.equal(approved.enqueue, false);

    const flags = executionFlagsForMode(OPERATING_MODES.AI_RECOMMENDED, { humanInitiated: true });
    assert.equal(flags.approved, false);
    assert.equal(flags.force, false);
});

test("feature: Human Escalation never auto-sends; only manual click can send", () => {
    const auto = gate("EMAIL", OPERATING_MODES.HUMAN_ESCALATION);
    assert.equal(auto.allowed, false);
    assert.equal(auto.enqueue, false);
    assert.equal(auto.assignRep, true);

    const manual = gate("EMAIL", OPERATING_MODES.HUMAN_ESCALATION, { manual: true });
    assert.equal(manual.allowed, true);

    const flags = executionFlagsForMode(OPERATING_MODES.HUMAN_ESCALATION, { humanInitiated: true });
    assert.equal(flags.manual, true);
    assert.equal(flags.force, true);
});

test("feature: WAIT and REP_CALLBACK are never blocked by operating mode", () => {
    for (const mode of Object.values(OPERATING_MODES)) {
        assert.equal(gate("WAIT", mode).allowed, true);
        assert.equal(gate("REP_CALLBACK", mode).allowed, true);
    }
});

test("feature: Hold delays due time so scheduler will not pick the lead", () => {
    const from = new Date("2026-10-27T00:00:00.000Z");
    const due = nextHoldUntil(from);
    assert.equal(due.getTime() - from.getTime(), HOLD_DURATION_MS);
    assert.equal(due <= from, false);
});

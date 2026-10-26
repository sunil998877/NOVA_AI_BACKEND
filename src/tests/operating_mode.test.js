import { test } from "node:test";
import assert from "node:assert/strict";
import {
    OPERATING_MODES,
    evaluateDispatch,
    executionFlagsForMode,
    seedOperatingMode,
    getCachedOperatingMode,
} from "../services/ase/operatingMode.service.js";
import { extractCallTranscript, normalizeTelephonyOutcome, ASE_OUTCOMES } from "../services/ase/outcomeNormalizer.service.js";

test("FULLY_AUTOMATED allows auto EMAIL/CALL; force only skips timing", () => {
    const email = evaluateDispatch("EMAIL", { mode: OPERATING_MODES.FULLY_AUTOMATED });
    const call = evaluateDispatch("CALL", { mode: OPERATING_MODES.FULLY_AUTOMATED });
    assert.equal(email.allowed, true);
    assert.equal(email.enqueue, false);
    assert.equal(call.allowed, true);
    const flags = executionFlagsForMode(OPERATING_MODES.FULLY_AUTOMATED, { humanInitiated: true });
    assert.equal(flags.force, true);
    assert.equal(flags.approved, false);
});

test("AI_RECOMMENDED queues EMAIL/CALL and force cannot send", () => {
    const blocked = evaluateDispatch("EMAIL", { mode: OPERATING_MODES.AI_RECOMMENDED });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.enqueue, true);

    const forceStillBlocked = evaluateDispatch("CALL", {
        mode: OPERATING_MODES.AI_RECOMMENDED,
        approved: false,
        manual: false,
    });
    assert.equal(forceStillBlocked.allowed, false);
    assert.equal(forceStillBlocked.enqueue, true);

    const approved = evaluateDispatch("EMAIL", {
        mode: OPERATING_MODES.AI_RECOMMENDED,
        approved: true,
    });
    assert.equal(approved.allowed, true);
    assert.equal(approved.enqueue, false);

    const wait = evaluateDispatch("WAIT", { mode: OPERATING_MODES.AI_RECOMMENDED });
    assert.equal(wait.allowed, true);
    assert.equal(wait.enqueue, false);
});

test("HUMAN_ESCALATION blocks auto send; only manual human click is allowed", () => {
    const blocked = evaluateDispatch("CALL", { mode: OPERATING_MODES.HUMAN_ESCALATION });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.enqueue, false);
    assert.equal(blocked.assignRep, true);

    const forceDoesNotBypass = evaluateDispatch("EMAIL", { mode: OPERATING_MODES.HUMAN_ESCALATION });
    assert.equal(forceDoesNotBypass.allowed, false);

    const manual = evaluateDispatch("EMAIL", {
        mode: OPERATING_MODES.HUMAN_ESCALATION,
        manual: true,
    });
    assert.equal(manual.allowed, true);
    assert.equal(manual.assignRep, false);
});

test("seedOperatingMode caches org-scoped mode without writing the scheduler", () => {
    seedOperatingMode(9, OPERATING_MODES.AI_RECOMMENDED);
    assert.equal(getCachedOperatingMode(9), OPERATING_MODES.AI_RECOMMENDED);
    seedOperatingMode(9, OPERATING_MODES.FULLY_AUTOMATED);
    assert.equal(getCachedOperatingMode(9), OPERATING_MODES.FULLY_AUTOMATED);
});

test("Agentflow payload extracts transcript and classifies interest", () => {
    const transcript = extractCallTranscript({
        data: {
            conversation: "Prospect: yes I am interested, let's book a meeting",
            disposition: "interested",
        },
        lead_id: 12,
    });
    assert.match(transcript, /yes i am interested/i);

    const normalized = normalizeTelephonyOutcome({
        transcript,
        disposition: "interested",
        lead_id: 12,
        Duration: 48,
    });
    assert.equal(normalized.isAnswered, true);
    assert.equal(normalized.normalizedOutcome, ASE_OUTCOMES.INTERESTED);
});

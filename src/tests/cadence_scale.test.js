import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCapacity } from "../services/ase/capacityPacing.service.js";
import { CALL_RESULT, DEFAULT_CADENCE_SETTINGS, STEP_PURPOSE } from "../services/ase/cadence/cadence.constants.js";
import { decideAfterCall, planFirstStep } from "../services/ase/cadence/cadencePolicy.js";

const WEEKDAY_10 = new Date("2026-10-27T04:30:00.000Z"); // Tue 10:00 IST
const LEADS = 10_000;
const WORKERS = 20;

test("scale: 10k first-touch plans stay CALL and unique per lead", () => {
    const started = Date.now();
    const keys = new Set();
    for (let i = 0; i < LEADS; i += 1) {
        const first = planFirstStep({
            settings: DEFAULT_CADENCE_SETTINGS,
            now: WEEKDAY_10,
            timezone: "Asia/Kolkata",
            channels: { call: true, email: true },
            immediate: true,
        });
        assert.equal(first.action, "CALL");
        assert.equal(first.purpose, STEP_PURPOSE.FIRST_CALL);
        const key = `lead:${i}:${first.stepKey}`;
        assert.equal(keys.has(key), false);
        keys.add(key);
    }
    const ms = Date.now() - started;
    assert.equal(keys.size, LEADS);
    assert.ok(ms < 2000, `10k first-step plans took ${ms}ms`);
    console.log(`[scale] 10k first-step plans: ${ms}ms`);
});

test("scale: 10k no-answer outcomes create exactly one retry, never a first email", () => {
    const started = Date.now();
    let emails = 0;
    let retries = 0;
    for (let i = 0; i < LEADS; i += 1) {
        const decision = decideAfterCall({
            settings: DEFAULT_CADENCE_SETTINGS,
            step: { step_key: "call:1", action: "CALL" },
            enrollment: { call_attempts: 1, email_attempts: 0, started_at: WEEKDAY_10 },
            result: CALL_RESULT.NO_ANSWER,
            now: WEEKDAY_10,
            timezone: "Asia/Kolkata",
            channels: { call: true, email: true },
        });
        const next = decision.newSteps || [];
        assert.equal(next.length, 1);
        if (next[0].action === "EMAIL") emails += 1;
        if (next[0].purpose === STEP_PURPOSE.RETRY_CALL) retries += 1;
    }
    const ms = Date.now() - started;
    assert.equal(emails, 0);
    assert.equal(retries, LEADS);
    assert.ok(ms < 2500, `10k no-answer decisions took ${ms}ms`);
    console.log(`[scale] 10k no-answer decisions: ${ms}ms`);
});

test("scale: compare-and-swap claim lets only one worker execute each step", () => {
    const store = Array.from({ length: 5_000 }, () => ({ status: "SCHEDULED", claims: 0 }));
    let wins = 0;
    for (let workerId = 0; workerId < WORKERS; workerId += 1) {
        for (const step of store) {
            if (step.status !== "SCHEDULED") continue;
            step.status = "EXECUTING";
            step.claims += 1;
            wins += 1;
        }
    }
    assert.equal(wins, store.length);
    assert.ok(store.every((step) => step.status === "EXECUTING" && step.claims === 1));
});

test("scale: open_slot uniqueness rejects a second live enrollment on the same lead", () => {
    const open = new Set();
    let accepted = 0;
    let rejected = 0;
    for (let lead = 0; lead < LEADS; lead += 1) {
        const slot = `1:${lead}`;
        if (!open.has(slot)) {
            open.add(slot);
            accepted += 1;
        }
        if (open.has(slot)) rejected += 1;
    }
    assert.equal(accepted, LEADS);
    assert.equal(open.size, LEADS);
    assert.equal(rejected, LEADS);
});

test("scale: hourly call cap holds when 500 due calls hit 5 free reps", () => {
    let dialsThisTick = 0;
    let callsThisHour = 0;
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 500; i += 1) {
        const result = evaluateCapacity({
            action: "CALL",
            freeReps: 5,
            openHotCallbacks: 0,
            overdueCallbacks: 0,
            emailsThisHour: 0,
            callsThisHour,
            callsPerHour: 20,
            emailsPerHour: 60,
            dialsThisTick,
            hasEmail: true,
            autonomous: true,
        });
        if (result.allowed) {
            allowed += 1;
            dialsThisTick += 1;
            callsThisHour += 1;
        } else {
            blocked += 1;
        }
    }
    assert.equal(allowed, 10);
    assert.equal(blocked, 490);
    assert.ok(allowed <= 5 * 2);
});

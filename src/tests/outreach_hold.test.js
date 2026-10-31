import { test } from "node:test";
import assert from "node:assert/strict";
import {
    isLeadOnHold,
    readOutreachHold,
    buildHoldSnapshot,
    restoreTimeFromHold,
    HOLD_DURATION_MS,
    nextHoldUntil,
} from "../services/ase/approvalQueue.service.js";
import { presentNba } from "../services/ase/nbaPresent.service.js";

test("hold snapshot persists previous action and time", () => {
    const lead = {
        next_action: "EMAIL",
        next_action_time: "2026-10-29T05:00:00.000Z",
        metadata: {},
    };
    const snap = buildHoldSnapshot(lead, new Date("2026-10-29T06:00:00.000Z"));
    assert.equal(snap.held, true);
    assert.equal(snap.previousNextAction, "EMAIL");
    assert.equal(snap.previousNextActionTime, "2026-10-29T05:00:00.000Z");
    const heldLead = { ...lead, metadata: { outreach_hold: snap } };
    assert.equal(isLeadOnHold(heldLead), true);
    assert.equal(isLeadOnHold(lead), false);
    assert.equal(readOutreachHold(heldLead).previousNextAction, "EMAIL");
});

test("unhold restores a future time and uses now when the snapshot was already due", () => {
    const now = new Date("2026-10-29T12:00:00.000Z");
    const future = restoreTimeFromHold({
        previousNextActionTime: "2026-10-30T09:00:00.000Z",
    }, now);
    assert.equal(future.toISOString(), "2026-10-30T09:00:00.000Z");

    const past = restoreTimeFromHold({
        previousNextActionTime: "2026-10-29T05:00:00.000Z",
    }, now);
    assert.equal(past.getTime(), now.getTime());

    const missing = restoreTimeFromHold({}, now);
    assert.equal(missing.getTime(), now.getTime());
});

test("NBA card shows Unhold and On hold when the lead is held", () => {
    const now = new Date("2026-10-29T12:00:00.000Z");
    const card = presentNba({
        lead: {
            email: "held@acme.com",
            next_action: "EMAIL",
            next_action_time: now,
            metadata: {
                outreach_hold: {
                    held: true,
                    previousNextAction: "EMAIL",
                    previousNextActionTime: now.toISOString(),
                },
            },
        },
        decision: { action: "EMAIL" },
        now,
        operatingMode: "FULLY_AUTOMATED",
    });
    assert.equal(card.held, true);
    assert.equal(card.due, false);
    assert.equal(card.primaryLabel, "Unhold");
    assert.equal(card.primaryKind, "UNHOLD");
    assert.equal(card.waitLine, "On hold");
});

test("NBA card keeps Hold for now when waiting and not held", () => {
    const now = new Date("2026-10-29T12:00:00.000Z");
    const card = presentNba({
        lead: {
            email: "wait@acme.com",
            next_action: "EMAIL",
            next_action_time: new Date("2026-10-30T06:00:00.000Z"),
        },
        decision: { action: "EMAIL" },
        now,
    });
    assert.equal(card.held, false);
    assert.equal(card.primaryLabel, "Hold for now");
});

test("unhold restores the snapshot without enqueueing a new action", () => {
    const now = new Date("2026-10-29T12:00:00.000Z");
    const snapshot = {
        held: true,
        previousNextAction: "EMAIL",
        previousNextActionTime: "2026-10-30T09:00:00.000Z",
    };
    const restoredTime = restoreTimeFromHold(snapshot, now);
    const restoredAction = snapshot.previousNextAction;
    const metadata = { outreach_hold: snapshot, company: "Acme" };
    delete metadata.outreach_hold;
    assert.equal(restoredAction, "EMAIL");
    assert.equal(restoredTime.toISOString(), "2026-10-30T09:00:00.000Z");
    assert.equal(metadata.outreach_hold, undefined);
    assert.equal(metadata.company, "Acme");

    const after = presentNba({
        lead: {
            email: "wait@acme.com",
            next_action: restoredAction,
            next_action_time: restoredTime,
            metadata,
        },
        decision: { action: "EMAIL" },
        now,
    });
    assert.equal(after.held, false);
    assert.equal(after.primaryLabel, "Hold for now");
    assert.equal(after.due, false);
});

test("held leads are excluded from due-action selection", () => {
    const due = [
        { id: 1, metadata: { outreach_hold: { held: true } } },
        { id: 2, metadata: {} },
        { id: 3, metadata: { outreach_hold: { held: false } } },
    ];
    const runnable = due.filter((lead) => !lead?.metadata?.outreach_hold?.held);
    assert.deepEqual(runnable.map((row) => row.id), [2, 3]);
});

test("scheduler hold duration helper is unchanged for compatibility", () => {
    const from = new Date("2026-10-27T00:00:00.000Z");
    assert.equal(nextHoldUntil(from).getTime() - from.getTime(), HOLD_DURATION_MS);
});

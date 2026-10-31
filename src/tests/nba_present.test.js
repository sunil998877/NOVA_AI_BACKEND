import { test } from "node:test";
import assert from "node:assert/strict";
import {
    formatWaitUntil,
    nbaNeverSaysWaitWhenModelSaysEmail,
    presentNba,
    resolveNbaChannel,
} from "../services/ase/nbaPresent.service.js";

const future = new Date("2026-10-28T11:50:00.000Z");
const now = new Date("2026-10-27T18:16:00.000Z");

test("heading is Next Best Action: Email when the model says Email even if stored action is WAIT", () => {
    const card = presentNba({
        lead: {
            email: "ops@acme.com",
            next_action: "WAIT",
            next_action_time: future,
            attempt_counters: { email: 1, voice: 0 },
        },
        decision: {
            action: "EMAIL",
            probabilities: { EMAIL: 0.83, WAIT: 0.12, CALL: 0.05 },
            explanation: "Selected EMAIL — email 83% wait 12% call 5%",
        },
        now,
    });
    assert.equal(card.channel, "EMAIL");
    assert.equal(card.heading, "Next Best Action: Email");
    assert.equal(card.rightWinner, "EMAIL");
    assert.equal(card.actionIsWait, false);
    assert.match(card.waitLine, /Wait until/i);
    assert.match(card.subline, /Follow-up email/);
    assert.equal(nbaNeverSaysWaitWhenModelSaysEmail(card), true);
    assert.equal(/wait/i.test(card.heading), false);
});

test("WAIT stored with only email 83% on the right panel still highlights Email, not Wait", () => {
    const card = presentNba({
        lead: { email: "a@b.com", next_action: "WAIT", next_action_time: future },
        decision: { action: "WAIT", probabilities: { EMAIL: 0.83, WAIT: 0.10, CALL: 0.07 } },
        now,
    });
    assert.equal(card.heading, "Next Best Action: Email");
    assert.equal(card.rightWinner, "EMAIL");
    assert.ok(card.percents.email > card.percents.wait);
});

test("pending clock uses Hold for now; due uses Send follow-up", () => {
    const pending = presentNba({
        lead: { email: "a@b.com", next_action: "EMAIL", next_action_time: future },
        decision: { action: "EMAIL" },
        now,
    });
    const due = presentNba({
        lead: { email: "a@b.com", next_action: "EMAIL", next_action_time: new Date("2026-10-27T10:00:00.000Z") },
        decision: { action: "EMAIL" },
        now,
        operatingMode: "FULLY_AUTOMATED",
    });
    const approve = presentNba({
        lead: { email: "a@b.com", next_action: "EMAIL", next_action_time: new Date("2026-10-27T10:00:00.000Z") },
        decision: { action: "EMAIL" },
        now,
        operatingMode: "AI_RECOMMENDED",
    });
    assert.equal(pending.due, false);
    assert.equal(pending.held, false);
    assert.equal(pending.primaryLabel, "Hold for now");
    assert.equal(due.due, true);
    assert.equal(due.primaryLabel, "Send follow-up");
    assert.equal(approve.primaryLabel, "Approve & send");
});

test("resolveNbaChannel never returns WAIT when Email is the model winner", () => {
    assert.equal(resolveNbaChannel({
        storedAction: "WAIT",
        decision: { action: "EMAIL" },
        lead: { email: "a@b.com" },
    }), "EMAIL");
});

test("Wait until formats weekday time IST", () => {
    const line = formatWaitUntil("2026-10-28T11:50:00.000Z", "Asia/Kolkata", now);
    assert.match(line, /Wait until/);
    assert.match(line, /IST/);
});

test("CALL-first lead shows First call, not First email", () => {
    const card = presentNba({
        lead: {
            phone: "+919876543210",
            email: "ops@acme.com",
            next_action: "CALL",
            next_action_time: future,
            timezone: "Asia/Kolkata",
            attempt_counters: { email: 0, voice: 0 },
        },
        decision: { action: "CALL" },
        now,
    });
    assert.equal(card.channel, "CALL");
    assert.equal(card.heading, "Next Best Action: Call");
    assert.equal(card.cadenceStep, "First call");
    assert.match(card.subline, /First call/);
    assert.doesNotMatch(card.subline, /First email/i);
});

test("CADENCE stored action with phone presents Call, not Email", () => {
    const card = presentNba({
        lead: {
            phone: "+919876543210",
            email: "ops@acme.com",
            next_action: "CADENCE",
            next_action_time: future,
            attempt_counters: { email: 0, voice: 0 },
        },
        decision: { action: "WAIT" },
        now,
    });
    assert.equal(card.channel, "CALL");
    assert.equal(card.cadenceStep, "First call");
});

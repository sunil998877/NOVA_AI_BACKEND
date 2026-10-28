import { test } from "node:test";
import assert from "node:assert/strict";
import { nbaNeverSaysWaitWhenModelSaysEmail, presentNba } from "../services/ase/nbaPresent.service.js";

test("feature: the card never says the action is Wait while the model says Email", () => {
    const card = presentNba({
        lead: {
            email: "ops@acme.com",
            next_action: "WAIT",
            next_action_time: new Date(Date.now() + 6 * 3600 * 1000),
        },
        decision: {
            action: "EMAIL",
            recommendedAction: "EMAIL",
            probabilities: { EMAIL: 0.83, WAIT: 0.12, CALL: 0.05 },
        },
    });
    assert.equal(card.channel, "EMAIL");
    assert.equal(card.heading, "Next Best Action: Email");
    assert.equal(card.rightWinner, card.channel);
    assert.equal(nbaNeverSaysWaitWhenModelSaysEmail(card), true);
    assert.doesNotMatch(card.heading, /wait/i);
    assert.match(card.subline, /Wait until|Due now|Ready now/i);
});

test("feature: right panel winner matches the left heading channel", () => {
    const email = presentNba({
        lead: { email: "a@b.com", next_action: "WAIT" },
        decision: { action: "EMAIL", probabilities: { EMAIL: 0.7, CALL: 0.2, WAIT: 0.1 } },
    });
    const call = presentNba({
        lead: { phone: "+15551230000", next_action: "WAIT" },
        decision: { action: "CALL", probabilities: { CALL: 0.6, EMAIL: 0.3, WAIT: 0.1 } },
    });
    assert.equal(email.heading, "Next Best Action: Email");
    assert.equal(email.rightWinner, "EMAIL");
    assert.equal(call.heading, "Next Best Action: Call");
    assert.equal(call.rightWinner, "CALL");
});

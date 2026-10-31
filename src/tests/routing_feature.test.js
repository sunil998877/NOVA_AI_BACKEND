import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRep, simulateEvenRouting } from "../services/ase/routing.service.js";
import { ROUTING_STRATEGIES } from "../services/ase/routing.constants.js";

test("feature: interest, callback, and human-escalation all use the same picker", () => {
    const reps = [
        { id: 101, openCallbacks: 0 },
        { id: 102, openCallbacks: 0 },
        { id: 103, openCallbacks: 0 },
    ];
    const interest = pickRep({ lead: {}, reps, cursor: 0, keepAssigned: false });
    const callback = pickRep({ lead: {}, reps, cursor: interest.cursor, keepAssigned: false });
    const escalation = pickRep({ lead: {}, reps, cursor: callback.cursor, keepAssigned: false });
    assert.equal(interest.rep.id, 101);
    assert.equal(callback.rep.id, 102);
    assert.equal(escalation.rep.id, 103);
});

test("feature: 12 hot leads across 3 reps stay within one of even", () => {
    const assigned = simulateEvenRouting([7, 8, 9], 12);
    const counts = assigned.reduce((acc, id) => {
        acc[id] = (acc[id] || 0) + 1;
        return acc;
    }, {});
    const values = Object.values(counts);
    assert.equal(values.length, 3);
    assert.equal(Math.max(...values) - Math.min(...values) <= 1, true);
    assert.equal(values.every((n) => n === 4), true);
});

test("feature: unassigned fallback is explicit so the console can alert", () => {
    const none = pickRep({ lead: { assigned_rep_id: null }, reps: [] });
    assert.equal(none.strategy, ROUTING_STRATEGIES.UNASSIGNED);
    assert.equal(none.alert, true);
    assert.equal(none.rep, null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    leadTeam,
    leadTerritory,
    nextRoundRobin,
    pickRep,
    simulateEvenRouting,
} from "../services/ase/routing.service.js";
import { ROUTING_STRATEGIES } from "../services/ase/routing.constants.js";

test("three reps receive new hot leads roughly evenly", () => {
    const assigned = simulateEvenRouting([11, 22, 33], 9);
    const counts = { 11: 0, 22: 0, 33: 0 };
    for (const id of assigned) counts[id] += 1;
    assert.equal(assigned.length, 9);
    assert.equal(counts[11], 3);
    assert.equal(counts[22], 3);
    assert.equal(counts[33], 3);
});

test("round-robin walks ids in order and wraps", () => {
    const reps = [{ id: 2 }, { id: 5 }, { id: 9 }];
    const first = nextRoundRobin(reps, 0);
    const second = nextRoundRobin(reps, first.cursor);
    const third = nextRoundRobin(reps, second.cursor);
    const fourth = nextRoundRobin(reps, third.cursor);
    assert.equal(first.rep.id, 2);
    assert.equal(second.rep.id, 5);
    assert.equal(third.rep.id, 9);
    assert.equal(fourth.rep.id, 2);
});

test("territory (city/state) beats generic round-robin", () => {
    const reps = [
        { id: 1, territories: ["delhi"], openCallbacks: 0 },
        { id: 2, territories: ["mumbai", "mh"], openCallbacks: 0 },
        { id: 3, territories: ["bengaluru"], openCallbacks: 0 },
    ];
    const picked = pickRep({
        lead: { city: "Mumbai", state: "MH" },
        reps,
        cursor: 1,
        keepAssigned: false,
    });
    assert.equal(picked.rep.id, 2);
    assert.equal(picked.strategy, ROUTING_STRATEGIES.TERRITORY);
});

test("team match routes within the same team", () => {
    const reps = [
        { id: 1, team: "east", openCallbacks: 0 },
        { id: 2, team: "west", openCallbacks: 0 },
        { id: 3, team: "west", openCallbacks: 4 },
    ];
    const picked = pickRep({
        lead: { team: "west" },
        reps,
        keepAssigned: false,
    });
    assert.equal(picked.rep.id, 2);
    assert.equal(picked.strategy, ROUTING_STRATEGIES.TEAM);
});

test("fewest open callbacks wins among equal territory/team", () => {
    const reps = [
        { id: 1, openCallbacks: 5 },
        { id: 2, openCallbacks: 1 },
        { id: 3, openCallbacks: 3 },
    ];
    const picked = pickRep({ lead: {}, reps, keepAssigned: false });
    assert.equal(picked.rep.id, 2);
    assert.equal(picked.strategy, ROUTING_STRATEGIES.WORKLOAD);
});

test("already assigned hot lead stays with that rep", () => {
    const reps = [
        { id: 1, openCallbacks: 0 },
        { id: 2, openCallbacks: 9 },
    ];
    const picked = pickRep({
        lead: { assigned_rep_id: 2 },
        reps,
        keepAssigned: true,
    });
    assert.equal(picked.rep.id, 2);
    assert.equal(picked.strategy, ROUTING_STRATEGIES.EXISTING);
});

test("no routable rep returns unassigned plus alert", () => {
    const picked = pickRep({ lead: { city: "Pune" }, reps: [] });
    assert.equal(picked.rep, null);
    assert.equal(picked.strategy, ROUTING_STRATEGIES.UNASSIGNED);
    assert.equal(picked.alert, true);
});

test("lead territory and team read city/state/team from segment attributes", () => {
    assert.deepEqual(
        leadTerritory({ segment_attributes: { city: "Pune", state: "Maharashtra" } }).sort(),
        ["maharashtra", "pune"]
    );
    assert.equal(leadTeam({ metadata: { team: "West" } }), "west");
});

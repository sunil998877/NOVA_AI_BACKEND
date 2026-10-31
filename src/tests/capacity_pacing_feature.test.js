import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCapacity, engineMayAddAutonomousCall } from "../services/ase/capacityPacing.service.js";
import { CAPACITY_REASONS } from "../services/ase/capacityPacing.constants.js";

function schedulerWouldDial(snapshot, extras = {}) {
    return evaluateCapacity({
        action: "CALL",
        autonomous: true,
        hasEmail: true,
        ...snapshot,
        ...extras,
    }).allowed;
}

test("feature: 20 overdue callbacks stops autonomous CALL even when many reps are free", () => {
    assert.equal(
        schedulerWouldDial({
            freeReps: 12,
            openHotCallbacks: 20,
            overdueCallbacks: 20,
        }),
        false
    );
    assert.equal(
        engineMayAddAutonomousCall({
            freeReps: 12,
            openHotCallbacks: 20,
            overdueCallbacks: 20,
        }),
        false
    );
});

test("feature: deep queue shifts the due CALL to EMAIL instead of dialling", () => {
    const verdict = evaluateCapacity({
        action: "CALL",
        freeReps: 8,
        openHotCallbacks: 22,
        overdueCallbacks: 22,
        hasEmail: true,
        autonomous: true,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.shiftedAction, "EMAIL");
    assert.equal(verdict.reason, CAPACITY_REASONS.CALLBACK_QUEUE_DEEP);
});

test("feature: Execute Now / approved / manual still may call when the queue is deep", () => {
    const force = evaluateCapacity({
        action: "CALL",
        overdueCallbacks: 20,
        openHotCallbacks: 20,
        autonomous: false,
    });
    assert.equal(force.allowed, true);
});

test("feature: scheduling a future CALL does not spend this tick's dial slots", () => {
    const check = evaluateCapacity({
        action: "CALL",
        freeReps: 1,
        openHotCallbacks: 0,
        overdueCallbacks: 0,
        dialsThisTick: 0,
        autonomous: true,
    });
    const stillOpen = evaluateCapacity({
        action: "CALL",
        freeReps: 1,
        openHotCallbacks: 0,
        overdueCallbacks: 0,
        dialsThisTick: 0,
        autonomous: true,
    });
    assert.equal(check.allowed, true);
    assert.equal(stillOpen.allowed, true);
    assert.equal(check.maxNewDials, 2);
});

test("feature: WAIT and EMAIL are not blocked by dial capacity", () => {
    const wait = evaluateCapacity({
        action: "WAIT",
        overdueCallbacks: 20,
        autonomous: true,
    });
    const email = evaluateCapacity({
        action: "EMAIL",
        overdueCallbacks: 20,
        openHotCallbacks: 20,
        emailsThisHour: 1,
        emailsPerHour: 60,
        autonomous: true,
    });
    assert.equal(wait.allowed, true);
    assert.equal(email.allowed, true);
});

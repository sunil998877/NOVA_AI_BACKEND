import { test } from "node:test";
import assert from "node:assert/strict";
import {
    computeMaxNewDials,
    countFreeReps,
    engineMayAddAutonomousCall,
    evaluateCapacity,
    isCallbackQueueDeep,
    readHourlyCaps,
} from "../services/ase/capacityPacing.service.js";
import { CAPACITY_REASONS, DEEP_CALLBACK_QUEUE, DIALS_PER_FREE_REP } from "../services/ase/capacityPacing.constants.js";

test("maxNewDials = max(0, freeReps * 2 - openHotCallbacks)", () => {
    assert.equal(DIALS_PER_FREE_REP, 2);
    assert.equal(computeMaxNewDials({ freeReps: 3, openHotCallbacks: 1 }), 5);
    assert.equal(computeMaxNewDials({ freeReps: 1, openHotCallbacks: 3 }), 0);
    assert.equal(computeMaxNewDials({ freeReps: 0, openHotCallbacks: 0 }), 0);
});

test("20 overdue callbacks is a deep queue", () => {
    assert.equal(DEEP_CALLBACK_QUEUE, 20);
    assert.equal(isCallbackQueueDeep(19), false);
    assert.equal(isCallbackQueueDeep(20), true);
    assert.equal(isCallbackQueueDeep(48), true);
});

test("20 overdue callbacks ⇒ engine does not add new autonomous calls", () => {
    const blocked = evaluateCapacity({
        action: "CALL",
        freeReps: 15,
        openHotCallbacks: 20,
        overdueCallbacks: 20,
        hasEmail: true,
        autonomous: true,
    });
    assert.equal(engineMayAddAutonomousCall({
        freeReps: 15,
        openHotCallbacks: 20,
        overdueCallbacks: 20,
    }), false);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, CAPACITY_REASONS.CALLBACK_QUEUE_DEEP);
    assert.equal(blocked.shiftedAction, "EMAIL");
});

test("deep queue with no email shifts CALL to WAIT", () => {
    const blocked = evaluateCapacity({
        action: "CALL",
        overdueCallbacks: 20,
        hasEmail: false,
        autonomous: true,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.shiftedAction, "WAIT");
});

test("one free rep and an empty callback queue allows two new dials this tick", () => {
    const first = evaluateCapacity({
        action: "CALL",
        freeReps: 1,
        openHotCallbacks: 0,
        overdueCallbacks: 0,
        dialsThisTick: 0,
        autonomous: true,
    });
    const third = evaluateCapacity({
        action: "CALL",
        freeReps: 1,
        openHotCallbacks: 0,
        overdueCallbacks: 0,
        dialsThisTick: 2,
        autonomous: true,
    });
    assert.equal(first.allowed, true);
    assert.equal(first.maxNewDials, 2);
    assert.equal(third.allowed, false);
    assert.equal(third.reason, CAPACITY_REASONS.NO_DIAL_CAPACITY);
});

test("hourly call cap blocks CALL and hourly email cap defers EMAIL", () => {
    const callCap = evaluateCapacity({
        action: "CALL",
        freeReps: 4,
        overdueCallbacks: 0,
        openHotCallbacks: 0,
        callsThisHour: 20,
        callsPerHour: 20,
        autonomous: true,
        hasEmail: true,
    });
    assert.equal(callCap.allowed, false);
    assert.equal(callCap.reason, CAPACITY_REASONS.CALLS_PER_HOUR_CAP);

    const emailCap = evaluateCapacity({
        action: "EMAIL",
        emailsThisHour: 60,
        emailsPerHour: 60,
        autonomous: true,
    });
    assert.equal(emailCap.allowed, false);
    assert.equal(emailCap.shiftedAction, "WAIT");
    assert.equal(emailCap.reason, CAPACITY_REASONS.EMAILS_PER_HOUR_CAP);
});

test("human force/manual/approved CALL is not paced", () => {
    const human = evaluateCapacity({
        action: "CALL",
        overdueCallbacks: 20,
        openHotCallbacks: 20,
        autonomous: false,
    });
    assert.equal(human.allowed, true);
    assert.equal(human.shiftedAction, null);
});

test("free reps use not-ON_CALL, with a solo-org floor of 1", () => {
    assert.equal(countFreeReps({ salesRepCount: 4, onCallCount: 1 }), 3);
    assert.equal(countFreeReps({ salesRepCount: 0, onCallCount: 0 }), 1);
    assert.equal(countFreeReps({ salesRepCount: 2, onCallCount: 0, onlineCount: 1 }), 1);
});

test("live ASE AVAILABLE count wins over not-ON_CALL when sockets are present", () => {
    assert.equal(countFreeReps({ salesRepCount: 4, onCallCount: 1, aseFreeCount: 1 }), 1);
    assert.equal(countFreeReps({ salesRepCount: 4, onCallCount: 1, aseFreeCount: 0 }), 0);
    assert.equal(countFreeReps({ salesRepCount: 4, onCallCount: 1, aseFreeCount: null }), 3);
});

test("org settings override default emails/hour and calls/hour", () => {
    const caps = readHourlyCaps({ capacity: { emailsPerHour: 12, callsPerHour: 3 } }, { emailsPerHour: 60, callsPerHour: 20 });
    assert.equal(caps.emailsPerHour, 12);
    assert.equal(caps.callsPerHour, 3);
});

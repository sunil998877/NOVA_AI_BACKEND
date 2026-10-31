import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ASE_PRESENCE_STATES, TRANSFER_WINDOW_SECONDS } from "../services/ase/asePresence.constants.js";
import {
    countAseFreeNow,
    countAseFreeWithin,
    hasLiveAsePresence,
    isFreeNow,
    isFreeWithin,
    pickFreeRep,
    presentAseRep,
} from "../services/ase/asePresence.service.js";
import { asePresenceStore } from "../socket/asePresence.store.js";
import { registerAsePresenceHandlers } from "../socket/asePresenceHandlers.js";
import { countFreeReps } from "../services/ase/capacityPacing.service.js";

beforeEach(() => {
    asePresenceStore.reset();
});

function joinRep(userId, extras = {}) {
    return asePresenceStore.join({
        userId,
        organizationId: 7,
        socketId: extras.socketId || `sock-${userId}`,
        name: extras.name || `Rep ${userId}`,
        role: extras.role || "SALESPERSON",
        state: extras.state || ASE_PRESENCE_STATES.AVAILABLE,
    });
}

test("AVAILABLE is free now; ON_CALL / AWAY / OFFLINE are not", () => {
    const available = presentAseRep({ userId: "1", state: "AVAILABLE", socketCount: 1, lastHeartbeatAt: new Date().toISOString() });
    const onCall = presentAseRep({ userId: "2", state: "ON_CALL", socketCount: 1, lastHeartbeatAt: new Date().toISOString(), freeWithinSeconds: 12 });
    const away = presentAseRep({ userId: "3", state: "AWAY", socketCount: 1, lastHeartbeatAt: new Date().toISOString() });
    const offline = presentAseRep({ userId: "4", state: "AVAILABLE", socketCount: 0 });
    assert.equal(available.state, ASE_PRESENCE_STATES.AVAILABLE);
    assert.equal(isFreeNow(available), true);
    assert.equal(isFreeNow(onCall), false);
    assert.equal(isFreeNow(away), false);
    assert.equal(offline.state, ASE_PRESENCE_STATES.OFFLINE);
    assert.equal(isFreeNow(offline), false);
});

test("free-within matches the 8-15s transfer window and never counts OFFLINE", () => {
    const window = TRANSFER_WINDOW_SECONDS.default;
    const soon = presentAseRep({
        userId: "2",
        state: "ON_CALL",
        socketCount: 1,
        lastHeartbeatAt: new Date().toISOString(),
        freeWithinSeconds: 12,
    });
    const late = presentAseRep({
        userId: "3",
        state: "ON_CALL",
        socketCount: 1,
        lastHeartbeatAt: new Date().toISOString(),
        freeWithinSeconds: 20,
    });
    const gone = presentAseRep({ userId: "4", state: "ON_CALL", socketCount: 0, freeWithinSeconds: 8 });
    assert.equal(window, 12);
    assert.equal(isFreeWithin(soon, window), true);
    assert.equal(isFreeWithin(late, window), false);
    assert.equal(isFreeWithin(gone, window), false);
});

test("store join/leave and setState drive org roster", () => {
    joinRep("11", { name: "Asha" });
    joinRep("12", { name: "Vikram" });
    asePresenceStore.setState("12", { state: ASE_PRESENCE_STATES.ON_CALL, freeWithinSeconds: 12 });
    const live = asePresenceStore.listByOrg(7);
    assert.equal(hasLiveAsePresence(live), true);
    assert.equal(countAseFreeNow(live), 1);
    assert.equal(countAseFreeWithin(live, 12), 2);
    assert.equal(pickFreeRep(live).userId, "11");

    asePresenceStore.leave("sock-11");
    asePresenceStore.leave("sock-12");
    const after = asePresenceStore.listByOrg(7);
    assert.equal(hasLiveAsePresence(after), false);
    assert.equal(countAseFreeNow(after), 0);
});

test("influencer sockets do not join the ASE presence channel", () => {
    const events = [];
    const io = { to: () => ({ emit: (ev, payload) => events.push({ ev, payload }) }) };
    const socket = {
        id: "inf-1",
        user: { role: "influencer", organization_id: 7, id: "9" },
        join() {},
        emit() {},
        on() {},
    };
    registerAsePresenceHandlers(io, socket);
    assert.equal(asePresenceStore.listByOrg(7).length, 0);
    assert.equal(events.length, 0);
});

test("salesperson socket joins AVAILABLE and can move to ON_CALL", () => {
    const broadcasts = [];
    const io = { to: () => ({ emit: (ev, payload) => broadcasts.push({ ev, payload }) }) };
    const handlers = {};
    const socket = {
        id: "u-1",
        user: {
            id: "21",
            userId: 21,
            organization_id: 7,
            aseRole: "SALESPERSON",
            role: "user",
            name: "Asha",
        },
        join() {},
        emit() {},
        on(ev, fn) {
            handlers[ev] = fn;
        },
    };
    registerAsePresenceHandlers(io, socket);
    assert.equal(countAseFreeNow(asePresenceStore.listByOrg(7)), 1);
    handlers["ase:presence:set"]({ state: "ON_CALL", freeWithinSeconds: 12 });
    const live = asePresenceStore.listByOrg(7);
    assert.equal(countAseFreeNow(live), 0);
    assert.equal(countAseFreeWithin(live, 12), 1);
    assert.equal(broadcasts.at(-1).ev, "ase:presence:state");
});

test("pacing uses ASE free now, not free-within", () => {
    joinRep("31");
    joinRep("32");
    asePresenceStore.setState("32", { state: ASE_PRESENCE_STATES.ON_CALL, freeWithinSeconds: 12 });
    const live = asePresenceStore.listByOrg(7);
    assert.equal(countFreeReps({ salesRepCount: 2, onCallCount: 1, aseFreeCount: countAseFreeNow(live) }), 1);
    assert.equal(countAseFreeWithin(live, 12), 2);
});

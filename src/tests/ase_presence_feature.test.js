import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ASE_PRESENCE_STATES } from "../services/ase/asePresence.constants.js";
import {
    countAseFreeNow,
    countAseFreeWithin,
    hasLiveAsePresence,
    isFreeWithin,
    presentAseRep,
} from "../services/ase/asePresence.service.js";
import { asePresenceStore } from "../socket/asePresence.store.js";
import { countFreeReps, computeMaxNewDials } from "../services/ase/capacityPacing.service.js";

beforeEach(() => {
    asePresenceStore.reset();
});

test("feature: AVAILABLE / ON_CALL / AWAY / OFFLINE feed FR-25 presence, not influencer chat online", () => {
    asePresenceStore.join({
        userId: "1",
        organizationId: 3,
        socketId: "a",
        name: "Asha",
        state: ASE_PRESENCE_STATES.AVAILABLE,
    });
    asePresenceStore.join({
        userId: "2",
        organizationId: 3,
        socketId: "b",
        name: "Vikram",
        state: ASE_PRESENCE_STATES.AVAILABLE,
    });
    asePresenceStore.setState("2", { state: ASE_PRESENCE_STATES.ON_CALL, freeWithinSeconds: 12 });
    asePresenceStore.join({
        userId: "3",
        organizationId: 3,
        socketId: "c",
        name: "Neha",
        state: ASE_PRESENCE_STATES.AVAILABLE,
    });
    asePresenceStore.setState("3", { state: ASE_PRESENCE_STATES.AWAY });

    const live = asePresenceStore.listByOrg(3);
    assert.equal(hasLiveAsePresence(live), true);
    assert.equal(countAseFreeNow(live), 1);
    assert.equal(countFreeReps({ salesRepCount: 3, onCallCount: 1, aseFreeCount: countAseFreeNow(live) }), 1);
    assert.equal(computeMaxNewDials({ freeReps: 1, openHotCallbacks: 0 }), 2);
});

test("feature: free within 12s is for the 8-15s transfer window, not extra pacing dials", () => {
    const onCallSoon = presentAseRep({
        userId: "9",
        state: "ON_CALL",
        socketCount: 1,
        lastHeartbeatAt: new Date().toISOString(),
        freeWithinSeconds: 12,
    });
    assert.equal(isFreeWithin(onCallSoon, 12), true);
    assert.equal(countAseFreeNow([onCallSoon]), 0);
    assert.equal(countAseFreeWithin([onCallSoon], 12), 1);
    assert.equal(countFreeReps({ salesRepCount: 1, onCallCount: 1, aseFreeCount: 0 }), 0);
});

test("feature: no live ASE sockets falls back to not-ON_CALL so overnight dials continue", () => {
    assert.equal(hasLiveAsePresence(asePresenceStore.listByOrg(3)), false);
    const freeReps = countFreeReps({
        salesRepCount: 4,
        onCallCount: 1,
        aseFreeCount: hasLiveAsePresence([]) ? 0 : null,
    });
    assert.equal(freeReps, 3);
    assert.equal(computeMaxNewDials({ freeReps, openHotCallbacks: 0 }), 6);
});

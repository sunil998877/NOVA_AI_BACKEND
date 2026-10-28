import { test } from "node:test";
import assert from "node:assert/strict";
import { ASE_PRESENCE_STATES } from "../services/ase/asePresence.constants.js";
import {
    evaluateWarmTransfer,
    isLiveCallForTransfer,
} from "../services/ase/warmTransfer.service.js";
import { WARM_TRANSFER_ACTIONS, WARM_TRANSFER_REASONS } from "../services/ase/warmTransfer.constants.js";
import { shouldQueueHumanHandoff, classifyProspectSpeech, ASE_OUTCOMES } from "../services/ase/outcomeNormalizer.service.js";
import { schedulerWouldDispatch } from "../services/ase/lifecycle.service.js";

function liveRep(overrides = {}) {
    return {
        userId: "7",
        state: ASE_PRESENCE_STATES.AVAILABLE,
        socketCount: 1,
        lastHeartbeatAt: new Date().toISOString(),
        phone: "+919811122233",
        ...overrides,
    };
}

test("feature: interest during the call + free rep in 8-15s window is the red-path transfer", () => {
    const classified = classifyProspectSpeech("Sounds good, send details");
    assert.equal(classified.outcome, ASE_OUTCOMES.INTERESTED);
    assert.equal(shouldQueueHumanHandoff(classified.outcome, { isAnswered: true, callStatus: "in-progress" }), true);
    assert.equal(isLiveCallForTransfer({ CallUUID: "live-1", CallStatus: "in-progress", event: "intent" }), true);

    const verdict = evaluateWarmTransfer({
        liveCall: true,
        callUuid: "live-1",
        freeRep: liveRep({ state: ASE_PRESENCE_STATES.ON_CALL, freeWithinSeconds: 12 }),
        transferPhone: "+919811122233",
        windowSeconds: 12,
    });
    assert.equal(verdict.action, WARM_TRANSFER_ACTIONS.TRANSFER);
});

test("feature: no free rep uses callback SLA and never a second bot call", () => {
    const verdict = evaluateWarmTransfer({
        liveCall: true,
        callUuid: "live-2",
        freeRep: null,
    });
    assert.equal(verdict.action, WARM_TRANSFER_ACTIONS.CALLBACK);
    assert.equal(verdict.reason, WARM_TRANSFER_REASONS.NO_FREE_REP);
    assert.equal(
        schedulerWouldDispatch({ status: "CALLBACK_SCHEDULED", next_action: "REP_CALLBACK", do_not_contact: 0 }, "CALL"),
        false
    );
});

test("feature: hangup interest cannot conference — missed transfer is the existing callback queue", () => {
    assert.equal(isLiveCallForTransfer({ CallUUID: "done-1", CallStatus: "completed", event: "hangup" }), false);
    const verdict = evaluateWarmTransfer({
        liveCall: false,
        callUuid: "done-1",
        freeRep: liveRep(),
        transferPhone: "+919811122233",
    });
    assert.equal(verdict.action, WARM_TRANSFER_ACTIONS.CALLBACK);
    assert.equal(verdict.reason, WARM_TRANSFER_REASONS.CALL_NOT_LIVE);
});

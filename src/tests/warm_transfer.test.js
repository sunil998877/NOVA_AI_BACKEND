import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ASE_PRESENCE_STATES, TRANSFER_WINDOW_SECONDS } from "../services/ase/asePresence.constants.js";
import { plivoVoiceAdapter } from "../services/ase/adapters/plivoVoice.adapter.js";
import { transitionLeadState } from "../services/ase/leadStateMachine.js";
import { engineMayContact, schedulerWouldDispatch } from "../services/ase/lifecycle.service.js";
import {
    clampTransferWindow,
    conferenceNameFor,
    evaluateWarmTransfer,
    isFinishedCallEvent,
    isLiveCallForTransfer,
    normalizeTransferPhone,
    resetWarmTransfers,
    resolveRepTransferPhone,
} from "../services/ase/warmTransfer.service.js";
import { WARM_TRANSFER_ACTIONS, WARM_TRANSFER_REASONS } from "../services/ase/warmTransfer.constants.js";
import { isAlreadyHumanHandoff } from "../services/ase/callbackHandoff.service.js";

beforeEach(() => {
    resetWarmTransfers();
});

function liveRep(overrides = {}) {
    return {
        userId: "44",
        state: ASE_PRESENCE_STATES.AVAILABLE,
        socketCount: 1,
        lastHeartbeatAt: new Date().toISOString(),
        freeWithinSeconds: 0,
        phone: "+919876543210",
        ...overrides,
    };
}

test("transfer window is clamped to 8-15 seconds", () => {
    assert.equal(clampTransferWindow(12), 12);
    assert.equal(clampTransferWindow(3), TRANSFER_WINDOW_SECONDS.min);
    assert.equal(clampTransferWindow(40), TRANSFER_WINDOW_SECONDS.max);
});

test("live in-progress Agentflow ping can transfer; hangup cannot", () => {
    assert.equal(isLiveCallForTransfer({ CallUUID: "abc", CallStatus: "in-progress", event: "intent" }), true);
    assert.equal(isLiveCallForTransfer({ CallUUID: "abc", CallStatus: "completed" }), false);
    assert.equal(isFinishedCallEvent({ event: "hangup", CallUUID: "abc" }), true);
    assert.equal(isLiveCallForTransfer({ CallStatus: "in-progress" }), false);
});

test("AVAILABLE or free-within 12s with a transfer number is TRANSFER", () => {
    const available = evaluateWarmTransfer({
        liveCall: true,
        callUuid: "uuid-1",
        freeRep: liveRep(),
        transferPhone: "+919876543210",
    });
    assert.equal(available.action, WARM_TRANSFER_ACTIONS.TRANSFER);

    const wrapping = evaluateWarmTransfer({
        liveCall: true,
        callUuid: "uuid-1",
        freeRep: liveRep({ state: ASE_PRESENCE_STATES.ON_CALL, freeWithinSeconds: 12 }),
        transferPhone: "+919876543210",
        windowSeconds: 12,
    });
    assert.equal(wrapping.action, WARM_TRANSFER_ACTIONS.TRANSFER);
});

test("no free rep, offline, or free-in 20s falls back to callback SLA", () => {
    assert.equal(evaluateWarmTransfer({ liveCall: true, callUuid: "u" }).reason, WARM_TRANSFER_REASONS.NO_FREE_REP);
    assert.equal(evaluateWarmTransfer({
        liveCall: true,
        callUuid: "u",
        freeRep: liveRep({ state: ASE_PRESENCE_STATES.OFFLINE, socketCount: 0 }),
        transferPhone: "+919876543210",
    }).reason, WARM_TRANSFER_REASONS.REP_OUTSIDE_WINDOW);
    assert.equal(evaluateWarmTransfer({
        liveCall: true,
        callUuid: "u",
        freeRep: liveRep({ state: ASE_PRESENCE_STATES.ON_CALL, freeWithinSeconds: 20 }),
        transferPhone: "+919876543210",
        windowSeconds: 12,
    }).reason, WARM_TRANSFER_REASONS.REP_OUTSIDE_WINDOW);
});

test("completed call and missing transfer number use callback, not conference", () => {
    assert.equal(evaluateWarmTransfer({
        liveCall: false,
        callUuid: "u",
        freeRep: liveRep(),
        transferPhone: "+919876543210",
    }).reason, WARM_TRANSFER_REASONS.CALL_NOT_LIVE);
    assert.equal(evaluateWarmTransfer({
        liveCall: true,
        callUuid: "u",
        freeRep: liveRep({ phone: "" }),
        transferPhone: "",
    }).reason, WARM_TRANSFER_REASONS.REP_NO_TRANSFER_NUMBER);
});

test("org overlay or PLIVO_TRANSFER_NUMBER supplies the rep leg", () => {
    const phone = resolveRepTransferPhone(
        { userId: "9" },
        { routing: { reps: { 9: { phone: "9876543210" } } } }
    );
    assert.equal(normalizeTransferPhone("9876543210"), "+919876543210");
    assert.equal(phone, "+919876543210");
});

test("state machine: WARM_TRANSFER → HANDED_OFF, fail → CALLBACK_SCHEDULED", () => {
    const started = transitionLeadState("INTERESTED", "WARM_TRANSFER");
    assert.equal(started.nextState, "WARM_TRANSFER");
    const done = transitionLeadState("WARM_TRANSFER", "HANDOFF_COMPLETED");
    assert.equal(done.nextState, "HANDED_OFF");
    const missed = transitionLeadState("WARM_TRANSFER", "TRANSFER_FAILED");
    assert.equal(missed.nextState, "CALLBACK_SCHEDULED");
});

test("handed-off and callback leads never get another bot CALL", () => {
    assert.equal(isAlreadyHumanHandoff({ status: "WARM_TRANSFER" }), true);
    assert.equal(isAlreadyHumanHandoff({ status: "HANDED_OFF" }), true);
    assert.equal(isAlreadyHumanHandoff({ status: "CALLBACK_SCHEDULED", next_action: "REP_CALLBACK" }), true);
    assert.equal(engineMayContact({ status: "HANDED_OFF", next_action: "REP_CALLBACK" }, "CALL").allowed, false);
    assert.equal(schedulerWouldDispatch({ status: "CALLBACK_SCHEDULED", next_action: "REP_CALLBACK" }, "CALL"), false);
});

test("conference XML holds the prospect and joins the rep", () => {
    const room = conferenceNameFor({ organizationId: 3, leadId: 11, callId: 99 });
    const bridge = plivoVoiceAdapter.generateConferenceXml({ conferenceName: room, message: "Please hold" });
    const join = plivoVoiceAdapter.generateConferenceXml({ conferenceName: room, endOnExit: true });
    const promise = plivoVoiceAdapter.generateCallbackPromiseXml("A specialist will call you back");
    assert.match(bridge, /<Conference/);
    assert.match(bridge, /Please hold/);
    assert.match(join, /endConferenceOnExit="true"/);
    assert.match(promise, /<Hangup/);
    assert.equal(room.startsWith("ase-3-l11-c99"), true);
});

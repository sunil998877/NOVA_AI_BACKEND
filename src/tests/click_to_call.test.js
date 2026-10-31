import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { plivoVoiceAdapter } from "../services/ase/adapters/plivoVoice.adapter.js";
import {
    classifyDialStatus,
    classifyPrimaryHangup,
    clickToCallAnswerXml,
    expireStaleClickToCallSession,
    reduceClickToCallEvent,
    resetClickToCallLocks,
    sessionFromCall,
    startClickToCall,
    toE164,
} from "../services/ase/clickToCall.service.js";
import { CLICK_TO_CALL_SOURCE, CLICK_TO_CALL_STATES } from "../services/ase/clickToCall.constants.js";

beforeEach(() => {
    resetClickToCallLocks();
});

function rahul(overrides = {}) {
    return {
        id: 214,
        name: "Rahul Sharma",
        phone: "8877563855",
        email: "rahul@example.com",
        do_not_contact: 0,
        assigned_rep_id: 7,
        voice_consent: { status: "GRANTED" },
        ...overrides,
    };
}

function mockDeps({ primaryPhone = "7352575923", plivoResult = null, existing = null, lead = rahul() } = {}) {
    const calls = [];
    let executeCalled = false;
    let placedTo = null;
    const adapter = {
        execute: async () => {
            executeCalled = true;
            return { status: "FAILED", error: "execute must not be used for click-to-call" };
        },
        startClickToCallLeg: async ({ to, mpcName }) => {
            placedTo = to;
            if (plivoResult) return plivoResult;
            assert.match(String(mpcName || ""), /nova-ctc-/);
            assert.doesNotMatch(String(mpcName || ""), /plivo\/answer/);
            return { status: "SUCCEEDED", rawResponse: { request_uuid: "uuid-primary" }, metadata: { callId: "uuid-primary" } };
        },
    };
    return {
        skipLock: true,
        skipEmit: true,
        skipSync: true,
        baseUrl: "https://example.test",
        primaryPhone,
        loadSettings: async () => ({}),
        Suppression: { isSuppressed: async () => false },
        Lead: { findById: async () => lead },
        Call: {
            findLatestOpenByLead: async () => existing,
            create: async (data) => {
                const call = {
                    id: calls.length + 1,
                    created_at: new Date().toISOString(),
                    completed_at: null,
                    ...data,
                };
                calls.push(call);
                return { call, created: true };
            },
            findById: async (_org, id) => calls.find((row) => row.id === id) || null,
            updateById: async (_org, id, fields) => {
                const call = calls.find((row) => row.id === id);
                Object.assign(call, fields);
                return call;
            },
        },
        adapter,
        calls,
        get executeCalled() {
            return executeCalled;
        },
        get placedTo() {
            return placedTo;
        },
    };
}

test("1. successful start rings the primary phone, not the lead", async () => {
    const deps = mockDeps();
    const result = await startClickToCall(1, 214, { id: 7 }, deps);
    assert.equal(result.session.state, CLICK_TO_CALL_STATES.CALLING_YOU);
    assert.equal(deps.placedTo, "+917352575923");
    assert.notEqual(deps.placedTo, "+918877563855");
    assert.equal(result.call.initiation_source, CLICK_TO_CALL_SOURCE);
    assert.equal(deps.executeCalled, false);
    assert.match(String(result.call.raw_metadata?.mpcName || ""), /nova-ctc-/);
});

test("2. primary unanswered never marks the lead as called", () => {
    const afterPlace = reduceClickToCallEvent({ state: CLICK_TO_CALL_STATES.INITIATING }, { type: "placed", primaryLegUuid: "a" });
    const afterHangup = reduceClickToCallEvent(afterPlace, { type: "primary_no_answer" });
    assert.equal(afterHangup.state, CLICK_TO_CALL_STATES.NO_ANSWER);
    assert.equal(afterHangup.leadCalled, false);
});

test("3. primary answer starts the lead call leg", () => {
    let session = reduceClickToCallEvent({ state: CLICK_TO_CALL_STATES.INITIATING }, { type: "placed" });
    session = reduceClickToCallEvent(session, { type: "primary_answered", primaryLegUuid: "a" });
    assert.equal(session.state, CLICK_TO_CALL_STATES.CALLING_LEAD);
    assert.equal(session.leadCalled, true);
    const xml = clickToCallAnswerXml({ leadNumber: "8877563855", callerId: "+918035087884" });
    assert.match(xml, /<Dial[^>]*record="true"/);
    assert.match(xml, /<Number>\+918877563855<\/Number>/);
    assert.doesNotMatch(xml, /this is Nova from Evoke/i);
    assert.doesNotMatch(xml, /Polly/);
    assert.doesNotMatch(xml, /<Hangup/);
});

test("4. both participants answer becomes connected", () => {
    let session = reduceClickToCallEvent({ state: CLICK_TO_CALL_STATES.CALLING_YOU }, { type: "primary_answered" });
    session = reduceClickToCallEvent(session, { type: "lead_answered", leadLegUuid: "b", at: "2026-10-29T08:00:00.000Z" });
    assert.equal(session.state, CLICK_TO_CALL_STATES.CONNECTED);
    assert.equal(session.leadLegUuid, "b");
});

test("5. lead busy or no-answer after primary answered", () => {
    const base = reduceClickToCallEvent({ state: CLICK_TO_CALL_STATES.CALLING_YOU }, { type: "primary_answered" });
    const busy = reduceClickToCallEvent(base, { type: "lead_busy" });
    const noAnswer = reduceClickToCallEvent(base, { type: "lead_no_answer" });
    assert.equal(busy.state, CLICK_TO_CALL_STATES.BUSY);
    assert.equal(noAnswer.state, CLICK_TO_CALL_STATES.NO_ANSWER);
    assert.equal(busy.leadCalled, true);
    assert.equal(classifyDialStatus({ DialStatus: "busy" }).type, "lead_busy");
    assert.equal(classifyDialStatus({ DialStatus: "no-answer" }).type, "lead_no_answer");
});

test("6. Plivo API failure marks the session failed without execute()", async () => {
    const deps = mockDeps({
        plivoResult: { status: "FAILED", error: "Plivo 400 invalid number" },
    });
    await assert.rejects(() => startClickToCall(1, 214, { id: 7 }, deps), /Plivo 400/);
    assert.equal(deps.executeCalled, false);
    assert.equal(deps.calls[0].normalized_outcome, "FAILED");
});

test("7b. a dropped initiating call is not reused", async () => {
    const deps = mockDeps({
        existing: {
            id: 52,
            created_at: new Date().toISOString(),
            provider_status: "initiated",
            initiation_source: CLICK_TO_CALL_SOURCE,
            raw_metadata: { mode: "click_to_call", sessionState: "initiating" },
        },
    });
    const result = await startClickToCall(1, 214, { id: 7 }, deps);
    assert.equal(result.reused, false);
    assert.equal(result.session.state, CLICK_TO_CALL_STATES.CALLING_YOU);
});

test("7. duplicate clicks reuse the in-flight session", async () => {
    const deps = mockDeps();
    deps.skipLock = false;
    const first = startClickToCall(1, 214, { id: 7 }, deps);
    const second = startClickToCall(1, 214, { id: 7 }, deps);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.call.id, b.call.id);
    assert.equal(b.reused || b.concurrent, true);
});

test("8. duplicate or out-of-order webhooks do not reopen a terminal session", () => {
    let session = reduceClickToCallEvent({ state: CLICK_TO_CALL_STATES.CALLING_YOU }, { type: "primary_no_answer" });
    session = reduceClickToCallEvent(session, { type: "primary_answered" });
    session = reduceClickToCallEvent(session, { type: "lead_answered" });
    assert.equal(session.state, CLICK_TO_CALL_STATES.NO_ANSWER);
    assert.equal(session.leadCalled, false);
});

test("9. either participant disconnects completes a connected session", () => {
    let session = reduceClickToCallEvent({ state: CLICK_TO_CALL_STATES.CALLING_YOU }, { type: "primary_answered", at: "2026-10-29T08:00:00.000Z" });
    session = reduceClickToCallEvent(session, { type: "lead_answered", at: "2026-10-29T08:00:05.000Z" });
    session = reduceClickToCallEvent(session, { type: "disconnected", at: "2026-10-29T08:01:05.000Z", durationSec: 60 });
    assert.equal(session.state, CLICK_TO_CALL_STATES.COMPLETED);
    assert.equal(session.connectedDurationSec, 60);
});

test("10. connected duration uses conversation time, not time since API request", () => {
    const session = reduceClickToCallEvent(
        {
            state: CLICK_TO_CALL_STATES.CONNECTED,
            connectedAt: "2026-10-29T08:00:10.000Z",
            initiatedAt: "2026-10-29T07:59:00.000Z",
        },
        { type: "disconnected", at: "2026-10-29T08:00:40.000Z" }
    );
    assert.equal(session.state, CLICK_TO_CALL_STATES.COMPLETED);
    assert.equal(session.connectedDurationSec, 30);
});

test("11. unauthorized-style invalid lead and missing phone are rejected", async () => {
    await assert.rejects(
        () => startClickToCall(1, 999, { id: 7 }, mockDeps({ lead: null })),
        /Lead not found/
    );
    await assert.rejects(
        () => startClickToCall(1, 214, { id: 7 }, mockDeps({ lead: rahul({ phone: "" }) })),
        /valid phone number/
    );
    await assert.rejects(
        () => startClickToCall(1, 214, { id: 7 }, mockDeps({ lead: rahul({ do_not_contact: 1 }) })),
        /Do Not Contact/
    );
    const previousTransfer = process.env.PLIVO_TRANSFER_NUMBER;
    process.env.PLIVO_TRANSFER_NUMBER = "";
    try {
        await assert.rejects(
            () => startClickToCall(1, 214, { id: 7 }, mockDeps({ primaryPhone: "" })),
            /PLIVO_TRANSFER_NUMBER/
        );
    } finally {
        process.env.PLIVO_TRANSFER_NUMBER = previousTransfer;
    }
});

test("12. autonomous AI answer XML stays Speak-only and is not used by click-to-call", () => {
    const aiXml = plivoVoiceAdapter.generateAnswerXml({ message: "Hello from Nova, this is an AI conversation." });
    assert.match(aiXml, /<Speak/);
    assert.doesNotMatch(aiXml, /<Dial/);
    assert.doesNotMatch(aiXml, /<Number>/);
    const humanXml = plivoVoiceAdapter.generateClickToCallDialXml({
        leadNumber: "+918877563855",
        callerId: "+918035087884",
    });
    assert.match(humanXml, /<Dial/);
    assert.equal(toE164("8877563855"), "+918877563855");
    assert.equal(classifyPrimaryHangup({ CallStatus: "no-answer" }), "primary_no_answer");
    const stored = sessionFromCall({
        id: 9,
        lead_id: 214,
        initiation_source: CLICK_TO_CALL_SOURCE,
        raw_metadata: { mode: "click_to_call", sessionState: "calling_you", primaryPhone: "+917352575923" },
    });
    assert.equal(stored.state, "calling_you");
});

test("14. a completed Plivo poll does not keep the button on Calling you", () => {
    const stored = sessionFromCall({
        id: 57,
        lead_id: 218,
        completed_at: "2026-10-29T10:31:20.000Z",
        provider_status: "ringing",
        initiation_source: CLICK_TO_CALL_SOURCE,
        raw_metadata: {
            mode: "click_to_call",
            sessionState: "calling_you",
            initiatedAt: "2026-10-29T10:31:07.639Z",
            lastProviderStatus: "completed",
        },
    });
    assert.equal(stored.state, CLICK_TO_CALL_STATES.NO_ANSWER);
    assert.equal(stored.label, "Call");
});

test("13. a stale Calling you session expires back to Call", () => {
    const fresh = expireStaleClickToCallSession({
        state: CLICK_TO_CALL_STATES.CALLING_YOU,
        initiatedAt: new Date().toISOString(),
    });
    assert.equal(fresh.state, CLICK_TO_CALL_STATES.CALLING_YOU);

    const stale = expireStaleClickToCallSession({
        state: CLICK_TO_CALL_STATES.CALLING_YOU,
        initiatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    assert.equal(stale.state, CLICK_TO_CALL_STATES.NO_ANSWER);
    assert.equal(stale.label, "Call");

    const missingTime = expireStaleClickToCallSession({
        state: CLICK_TO_CALL_STATES.CALLING_YOU,
    });
    assert.equal(missingTime.state, CLICK_TO_CALL_STATES.NO_ANSWER);
});

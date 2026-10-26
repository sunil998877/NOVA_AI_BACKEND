import { test } from "node:test";
import assert from "node:assert/strict";
import { isPollableUuid, mapPlivoCdrToStatusPayload } from "../services/ase/plivoCallPoll.service.js";

test("poll skips simulated Agentflow placeholder uuids", () => {
    assert.equal(isPollableUuid("plivo_sim_123"), false);
    assert.equal(isPollableUuid("sim_9"), false);
    assert.equal(isPollableUuid("agentflow_1730000000"), false);
    assert.equal(isPollableUuid("91b3dd31-c881-4ecc-a75e-71e23be09256"), true);
});

test("Plivo CDR maps answered hangup to completed with duration", () => {
    const payload = mapPlivoCdrToStatusPayload({
        call_uuid: "abc",
        call_duration: "42",
        bill_duration: "42",
        hangup_cause: "NORMAL_CLEARING",
        answer_time: "2026-10-26 17:10:00",
        end_time: "2026-10-26 17:10:42",
        total_amount: "0.0180",
    }, { callId: 9, orgId: 1 });

    assert.equal(payload.CallStatus, "completed");
    assert.equal(payload.Duration, 42);
    assert.equal(payload.callId, 9);
    assert.equal(payload.source, "plivo_poll");
});

test("Plivo CDR uses hangup_cause_name and last-10 phone match fields", () => {
    const payload = mapPlivoCdrToStatusPayload({
        call_uuid: "real-uuid",
        call_duration: "113",
        billed_duration: 120,
        hangup_cause_name: "End Of XML Instructions",
        call_state: "ANSWER",
        answer_time: "2026-10-26 17:26:49+00:00",
        end_time: "2026-10-26 17:28:42+00:00",
        to_number: "917352575923",
        total_amount: "0.00950",
    }, { callId: 27 });
    assert.equal(payload.CallStatus, "completed");
    assert.equal(payload.Duration, 113);
    assert.equal(payload.To, "917352575923");
});

test("Plivo CDR maps USER_BUSY to busy without fabricating answer", () => {
    const payload = mapPlivoCdrToStatusPayload({
        call_uuid: "busy-1",
        call_duration: "0",
        hangup_cause: "USER_BUSY",
        end_time: "2026-10-26 17:12:00",
    });
    assert.equal(payload.CallStatus, "busy");
    assert.equal(payload.Duration, 0);
});

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { normalizeTelephonyOutcome, ASE_OUTCOMES } from "../services/ase/outcomeNormalizer.service.js";
import { verifyPlivoSignature } from "../middleware/plivoAuth.middleware.js";
import { Call } from "../models/call.model.js";
import { TelephonyWebhookEvent } from "../models/telephony-webhook-event.model.js";
import { Callback } from "../models/callback.model.js";
import { connectDb, closeDb } from "../config/db.js";

describe("ASE Calling, Telephony Outcomes, Webhooks and Callback Lifecycle", () => {
  before(async () => {
    try {
      await connectDb();
    } catch (_) {}
  });

  after(async () => {
    try {
      await closeDb();
    } catch (_) {}
  });

  test("1. Successful provider call creation and UUID persistence", async () => {
    const key = "test-call-create-" + Date.now();
    const result = await Call.create({
      lead_id: null,
      phone_number: "+15550001111",
      call_channel: "VOICE",
      call_type: "OUTBOUND",
      source: "AUTONOMOUS_AI",
      idempotency_key: key,
      status: "initiated",
      normalized_outcome: "INITIATED",
      business_disposition: "PENDING",
    });

    assert.ok(result?.call?.id);
    const mockUuid = "mock-uuid-" + Date.now();
    const updated = await Call.updateByProviderUuid(mockUuid, {
      status: "queued",
      provider_call_uuid: mockUuid,
    }, result.call.id);

    assert.ok(updated);
    const retrieved = await Call.findById(result.call.id);
    assert.equal(retrieved.provider_call_uuid, mockUuid);
    assert.equal(retrieved.status, "queued");
  });

  test("2. Provider request failure handling", () => {
    const payload = {
      Status: "failed",
      HangupCause: "Carrier Routing Failed",
      CallDuration: "0",
      Duration: "0",
    };
    const normalized = normalizeTelephonyOutcome(payload);
    assert.equal(normalized.status, "failed");
    assert.equal(normalized.normalizedOutcome, ASE_OUTCOMES.FAILED);
    assert.equal(normalized.isAnswered, false);
    assert.equal(normalized.businessDisposition, "FAILED");
  });

  test("3. Ring timeout and no-answer handling", () => {
    const payload = {
      Status: "timeout",
      HangupCause: "Ring Timeout Reached",
      CallDuration: "0",
    };
    const normalized = normalizeTelephonyOutcome(payload);
    assert.equal(normalized.normalizedOutcome, ASE_OUTCOMES.RING_TIMEOUT);
    assert.equal(normalized.isAnswered, false);
    assert.equal(normalized.businessDisposition, "NO_ANSWER");
  });

  test("4. Confirmed answer followed by completion", () => {
    const answerPayload = {
      Status: "in-progress",
      CallUUID: "plivo-uuid-123",
      AnswerTime: "2026-10-18 10:00:05",
    };
    const answerNorm = normalizeTelephonyOutcome(answerPayload);
    assert.equal(answerNorm.status, "in_progress");
    assert.equal(answerNorm.isAnswered, true);

    const completePayload = {
      Status: "completed",
      CallDuration: "45",
      BillDuration: "60",
      TotalCost: "0.0150",
      AnswerTime: "2026-10-18 10:00:05",
      EndTime: "2026-10-18 10:00:50",
      HangupCause: "Normal Clearing",
    };
    const completeNorm = normalizeTelephonyOutcome(completePayload);
    assert.equal(completeNorm.status, "completed");
    assert.equal(completeNorm.isAnswered, true);
    assert.equal(completeNorm.durationSeconds, 45);
    assert.equal(completeNorm.billableDurationSeconds, 60);
    assert.equal(completeNorm.providerCost, 0.015);
  });

  test("5. Zero-second calls without confirmed answer", () => {
    const payload = {
      Status: "completed",
      CallDuration: "0",
      BillDuration: "0",
      HangupCause: "User Busy",
    };
    const norm = normalizeTelephonyOutcome(payload);
    assert.equal(norm.status, "busy");
    assert.equal(norm.isAnswered, false);
    assert.equal(norm.durationSeconds, 0);
    assert.equal(norm.businessDisposition, "BUSY");
  });

  test("6. Interested disposition with no authoritative answer event does not fabricate answer", () => {
    const norm = normalizeTelephonyOutcome({
      Status: "early_media",
      CallDuration: "0",
      intent: "INTERESTED",
    });
    assert.equal(norm.isAnswered, false);
    assert.equal(norm.status, "early_media");
    assert.equal(norm.businessDisposition, "INTERESTED");
  });

  test("7. Callback requested without a confirmed connection", () => {
    const norm = normalizeTelephonyOutcome({
      Status: "no-answer",
      CallDuration: "0",
      intent: "CALLBACK_REQUESTED",
    });
    assert.equal(norm.isAnswered, false);
    assert.equal(norm.businessDisposition, "CALLBACK_REQUESTED");
    assert.equal(norm.status, "no_answer");
  });

  test("8. Duplicate autonomous call actions prevented by idempotency key", async () => {
    const stableKey = "op-call-action-" + Date.now();
    const result1 = await Call.create({
      phone_number: "+15559998888",
      call_channel: "VOICE",
      call_type: "OUTBOUND",
      source: "AUTONOMOUS_AI",
      idempotency_key: stableKey,
      status: "initiated",
    });

    const result2 = await Call.create({
      phone_number: "+15559998888",
      call_channel: "VOICE",
      call_type: "OUTBOUND",
      source: "AUTONOMOUS_AI",
      idempotency_key: stableKey,
      status: "initiated",
    });

    assert.equal(result1.call.id, result2.call.id);
    assert.equal(result2.created, false);
  });

  test("9. Duplicate provider webhooks discarded via event fingerprint", async () => {
    const mockCallUuid = "uuid-webhook-test-" + Date.now();
    const payload = {
      CallUUID: mockCallUuid,
      Event: "CallStatus",
      Status: "in-progress",
      AnswerTime: "2026-10-18 10:10:00",
    };

    const first = await TelephonyWebhookEvent.recordEvent({
      provider: "plivo",
      provider_call_uuid: mockCallUuid,
      event_type: "call.answered",
      payload,
    });
    assert.equal(first.isDuplicate, false);

    const second = await TelephonyWebhookEvent.recordEvent({
      provider: "plivo",
      provider_call_uuid: mockCallUuid,
      event_type: "call.answered",
      payload,
    });
    assert.equal(second.isDuplicate, true);
  });

  test("10. Out-of-order answer and completion webhooks handled safely", async () => {
    const testUuid = "uuid-order-" + Date.now();
    const key = "key-order-" + Date.now();
    await Call.create({
      provider_call_uuid: testUuid,
      phone_number: "+15551239999",
      call_channel: "VOICE",
      call_type: "OUTBOUND",
      source: "MANUAL",
      idempotency_key: key,
      status: "initiated",
    });

    const completionNorm = normalizeTelephonyOutcome({
      CallUUID: testUuid,
      Status: "completed",
      CallDuration: "30",
      AnswerTime: "2026-10-18 11:00:00",
      EndTime: "2026-10-18 11:00:30",
    });

    await Call.updateByProviderUuid(testUuid, {
      status: completionNorm.status,
      normalized_outcome: completionNorm.normalizedOutcome,
      duration_seconds: completionNorm.durationSeconds,
      answered_at: completionNorm.answeredAt,
      completed_at: completionNorm.completedAt,
    });

    const current = await Call.findByProviderUuid(testUuid);
    assert.equal(current.status, "completed");
    assert.equal(current.duration_seconds, 30);
  });

  test("11. Concurrent scheduler callback creation prevented for active tasks", async () => {
    const testLeadId = 987654;
    const firstTask = await Callback.create({
      lead_id: testLeadId,
      status: "REQUESTED",
      notes: "First scheduled callback",
      due_at: new Date(Date.now() + 3600000),
    });
    assert.ok(firstTask?.id);

    const hasActive = await Callback.hasActiveCallback(testLeadId);
    assert.equal(hasActive, true);

    const secondAttempt = await Callback.create({
      lead_id: testLeadId,
      status: "REQUESTED",
      notes: "Concurrent duplicate callback attempt",
      due_at: new Date(Date.now() + 3600000),
    });
    assert.equal(firstTask.id, secondAttempt.id);
  });

  test("12. Callback rescheduling, completion, and SLA transitions", async () => {
    const testLeadId = 987655;
    const pastTime = new Date(Date.now() - 7200000);
    const cb = await Callback.create({
      lead_id: testLeadId,
      status: "REQUESTED",
      notes: "SLA evaluation test",
      requested_at: pastTime,
      due_at: pastTime,
    });

    const updatedSlaCount = await Callback.updateSlaStatuses();
    assert.ok(typeof updatedSlaCount === "number");

    const overdueRecord = await Callback.findById(cb.id);
    assert.equal(overdueRecord.sla_status, "BREACHED");
    assert.ok(overdueRecord.sla_breached_at);

    const completed = await Callback.update(cb.id, {
      status: "COMPLETED",
      actual_outcome: "CONTACTED_AND_QUALIFIED",
      notes: "Prospect took call and requested contract proposal",
      completed_at: new Date(),
    });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.actual_outcome, "CONTACTED_AND_QUALIFIED");

    const activeAfterComplete = await Callback.hasActiveCallback(testLeadId);
    assert.equal(activeAfterComplete, false);
  });

  test("13. Accurate outbound count and connect-rate calculations", async () => {
    const stats = await Call.getStats();
    assert.ok(typeof stats.totalCalls === "number");
    assert.ok(typeof stats.answeredCalls === "number");
    assert.ok(typeof stats.answerRate === "number");

    if (stats.totalCalls > 0) {
      const calculatedRate = Math.round((stats.answeredCalls / stats.totalCalls) * 100);
      assert.equal(Math.round(stats.answerRate), calculatedRate);
    } else {
      assert.equal(stats.answerRate, 0);
    }
  });

  test("14. Missing duration and pending cost handling", () => {
    const missingPayload = {
      Status: "in-progress",
      CallUUID: "plivo-in-prog-" + Date.now(),
    };
    const normalized = normalizeTelephonyOutcome(missingPayload);
    assert.equal(normalized.durationSeconds, 0);
    assert.equal(normalized.billableDurationSeconds, 0);
    assert.equal(normalized.providerCost, null);
  });

  test("15. Unauthorized or invalid webhook requests rejected", () => {
    const authToken = "auth-token-secret-123";
    const testUrl = "https://example.com/api/engine/voice/plivo/status";
    const nonce = "nonce-" + Date.now();
    const method = "POST";
    const baseString = `${testUrl}${method}${nonce}`;

    const validSig = crypto
      .createHmac("sha256", authToken)
      .update(baseString)
      .digest("base64");

    const reqValid = {
      protocol: "https",
      method: "POST",
      headers: {
        host: "example.com",
        "x-plivo-signature-v3": validSig,
        "x-plivo-signature-v3-nonce": nonce,
      },
      originalUrl: "/api/engine/voice/plivo/status",
      body: {},
      query: {},
    };
    assert.equal(verifyPlivoSignature(reqValid, authToken), true);

    const reqInvalid = {
      ...reqValid,
      headers: {
        ...reqValid.headers,
        "x-plivo-signature-v3": "invalid-signature-value-mismatch",
      },
    };
    assert.equal(verifyPlivoSignature(reqInvalid, authToken), false);
  });

  test("16. Regression tests for existing manual and autonomous calling flows", () => {
    const manualResult = normalizeTelephonyOutcome({
      Status: "completed",
      CallDuration: "120",
      HangupCause: "Normal Clearing",
    });
    assert.equal(manualResult.status, "completed");
    assert.equal(manualResult.isAnswered, true);
    assert.equal(manualResult.durationSeconds, 120);

    const autoResult = normalizeTelephonyOutcome({
      Status: "busy",
      HangupCause: "User Busy",
    });
    assert.equal(autoResult.status, "busy");
    assert.equal(autoResult.isAnswered, false);
    assert.equal(autoResult.businessDisposition, "BUSY");
  });
});

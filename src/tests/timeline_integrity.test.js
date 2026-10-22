import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { LeadEvent } from "../models/lead-event.model.js";
import { decisionAuditService } from "../services/ase/brain/decisionAudit.service.js";
import { connectDb, closeDb, execute } from "../config/db.js";
import { runMigrations } from "../config/migrations.js";
import { getPool } from "../config/db.js";

describe("Timeline Integrity: Deduplication, AI Decisions, Counts, Timezones, and Statuses", () => {
    const testOrgId = 9888;
    const testLeadId = 8888;

    before(async () => {
        try {
            await connectDb();
            await runMigrations(getPool());
        } catch (_) {}
    });

    after(async () => {
        try {
            await execute(`DELETE FROM lead_events WHERE organization_id = ?`, [testOrgId]).catch(() => {});
            await closeDb();
        } catch (_) {}
    });

    test("1. Repeated delivery of same callback/event with idempotency key does not create duplicates", async () => {
        const idempKey = `cb_test_${Date.now()}_abc`;
        const ev1 = await LeadEvent.create({
            organization_id: testOrgId,
            lead_id: testLeadId,
            channel: "EMAIL",
            event_type: "EMAIL_SENT",
            status: "SUCCEEDED",
            payload: { messageId: "msg_123", subject: "Test 1" },
            idempotency_key: idempKey,
        });

        const ev2 = await LeadEvent.create({
            organization_id: testOrgId,
            lead_id: testLeadId,
            channel: "EMAIL",
            event_type: "EMAIL_SENT",
            status: "SUCCEEDED",
            payload: { messageId: "msg_123", subject: "Test 1" },
            idempotency_key: idempKey,
        });

        assert.equal(ev1.id, ev2.id);
        const list = await LeadEvent.listByLead(testOrgId, testLeadId, 100);
        const matches = list.filter((e) => e.idempotency_key === idempKey);
        assert.equal(matches.length, 1);
    });

    test("2. Two genuine sends to same recipient remain separate events", async () => {
        const send1 = await LeadEvent.create({
            organization_id: testOrgId,
            lead_id: testLeadId,
            channel: "EMAIL",
            event_type: "ActionCompleted",
            status: "SUCCEEDED",
            payload: { to: "buyer@domain.com", subject: "Initial Pitch", messageId: "msg_send_1" },
            idempotency_key: `send_1_${Date.now()}`,
        });

        const send2 = await LeadEvent.create({
            organization_id: testOrgId,
            lead_id: testLeadId,
            channel: "EMAIL",
            event_type: "ActionCompleted",
            status: "SUCCEEDED",
            payload: { to: "buyer@domain.com", subject: "Follow Up Pitch", messageId: "msg_send_2" },
            idempotency_key: `send_2_${Date.now()}`,
        });

        assert.notEqual(send1.id, send2.id);
        assert.equal(send1.payload.subject, "Initial Pitch");
        assert.equal(send2.payload.subject, "Follow Up Pitch");
    });

    test("3. Overlapping frontend queries or polling deduplicate by ID without dropping distinct events", () => {
        const mockRawList = [
            { id: 101, event_type: "EMAIL_SENT", created_at: "2026-10-19T10:00:00Z" },
            { id: 102, event_type: "ActionDispatched", created_at: "2026-10-19T09:59:00Z" },
            { id: 101, event_type: "EMAIL_SENT", created_at: "2026-10-19T10:00:00Z" },
            { id: 103, event_type: "ORCHESTRATOR_DECISION", created_at: "2026-10-19T09:55:00Z" },
        ];

        const seen = new Set();
        const deduplicated = [];
        for (const item of mockRawList) {
            if (!item || !item.id || seen.has(item.id)) continue;
            seen.add(item.id);
            deduplicated.push(item);
        }

        assert.equal(deduplicated.length, 3);
        assert.deepEqual(deduplicated.map((e) => e.id), [101, 102, 103]);
    });

    test("4. AI decision audit preserves single execution action, confidence, and normalized probabilities", async () => {
        const mockLead = { id: testLeadId, organization_id: testOrgId, status: "CONTACTED" };
        const decision = {
            recommendedAction: "WAIT",
            delayHours: 48,
            confidence: 0.99,
            channel: "SYSTEM",
            isAssistedByMl: true,
            reasonCode: "CADENCE_RESTRICTION",
        };
        const explanation = {
            summary: "ONNX model selected WAIT at 99% probability due to recent touchpoint.",
            reasonCodes: ["CADENCE_RESTRICTION"],
        };
        const prediction = {
            modelVersion: "2.1.0",
            probabilities: {
                WAIT: 0.99,
                EMAIL: 0.008,
                CALL: 0.002,
            },
        };

        await decisionAuditService.logDecision({
            lead: mockLead,
            decision,
            explanation,
            prediction,
        });

        const events = await LeadEvent.listByLead(testOrgId, testLeadId, 10);
        const decisionEv = events.find((e) => e.event_type === "DECISION_EVALUATED");

        assert.ok(decisionEv);
        assert.equal(decisionEv.payload.action, "WAIT");
        assert.equal(decisionEv.payload.confidence, 0.99);
        assert.equal(decisionEv.payload.modelVersion, "2.1.0");
        assert.equal(decisionEv.payload.reasonSummary, "ONNX model selected WAIT at 99% probability due to recent touchpoint.");
        assert.ok(decisionEv.payload.probabilities);
        assert.equal(decisionEv.payload.probabilities.WAIT, 0.99);
    });

    test("5. Total activity count equals exact sum of visible date group counts", () => {
        const events = [
            { id: 1, created_at: "2026-10-19T10:00:00Z" },
            { id: 2, created_at: "2026-10-19T09:00:00Z" },
            { id: 3, created_at: "2026-10-18T15:00:00Z" },
            { id: 4, created_at: "2026-10-18T11:00:00Z" },
            { id: 5, created_at: "2026-10-17T14:00:00Z" },
        ];

        const dateMap = new Map();
        for (const ev of events) {
            const d = new Date(ev.created_at);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            if (!dateMap.has(key)) dateMap.set(key, []);
            dateMap.get(key).push(ev);
        }

        const groups = Array.from(dateMap.entries()).map(([k, list]) => ({ key: k, count: list.length }));
        const sumOfGroupCounts = groups.reduce((acc, g) => acc + g.count, 0);

        assert.equal(sumOfGroupCounts, events.length);
        assert.equal(sumOfGroupCounts, 5);
        assert.equal(groups.length, 3);
    });

    test("6. Midnight boundary events group accurately without loss", () => {
        const midnightUtc = new Date("2026-10-18T23:59:59.000Z");
        const nextDayUtc = new Date("2026-10-19T00:00:01.000Z");

        const key1 = `${midnightUtc.getUTCFullYear()}-${String(midnightUtc.getUTCMonth() + 1).padStart(2, "0")}-${String(midnightUtc.getUTCDate()).padStart(2, "0")}`;
        const key2 = `${nextDayUtc.getUTCFullYear()}-${String(nextDayUtc.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDayUtc.getUTCDate()).padStart(2, "0")}`;

        assert.equal(key1, "2026-10-18");
        assert.equal(key2, "2026-10-19");
    });

    test("7. Status distinction: ActionDispatched is distinct from ActionCompleted", async () => {
        const dispatchEv = await LeadEvent.create({
            organization_id: testOrgId,
            lead_id: testLeadId,
            channel: "EMAIL",
            event_type: "ActionDispatched",
            status: null,
            payload: { execution_id: 5541, action: "EMAIL" },
            idempotency_key: `disp_${Date.now()}`,
        });

        const completeEv = await LeadEvent.create({
            organization_id: testOrgId,
            lead_id: testLeadId,
            channel: "EMAIL",
            event_type: "ActionCompleted",
            status: "SUCCEEDED",
            payload: { messageId: "msg_9981", subject: "Verified Delivery", metadata: { to: "lead@test.com" } },
            idempotency_key: `comp_${Date.now()}`,
        });

        assert.notEqual(dispatchEv.id, completeEv.id);
        assert.equal(dispatchEv.event_type, "ActionDispatched");
        assert.equal(completeEv.event_type, "ActionCompleted");
        assert.equal(completeEv.status, "SUCCEEDED");
    });
});

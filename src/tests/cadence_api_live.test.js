process.env.NODE_ENV = "test";
process.env.PLIVO_AUTH_ID = "";
process.env.PLIVO_AGENT_AUTH_ID = "";
process.env.PLIVO_AUTH_TOKEN = "";
process.env.PLIVO_AGENT_AUTH_TOKEN = "";
process.env.PLIVO_PHONE_NUMBER = "";
process.env.OPENAI_API_KEY = "";
process.env.ASE_OPENAI_API_KEY = "";
process.env.ASE_CADENCE_LOG_ML = "false";

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

const ORG = 9976;
const OTHER_ORG = 9975;
let db;
let server;
let base;
let adminToken;
let repToken;
let Lead;
let CadenceStep;

const TABLES = ["follow_up_automation_settings", "ase_cadence_steps", "ase_cadence_enrollments", "ase_cadence_policies", "telephony_webhook_events", "calls", "ase_executions", "lead_events", "leads"];

async function cleanup() {
    for (const org of [ORG, OTHER_ORG]) {
        for (const table of TABLES) await db.execute(`DELETE FROM ${table} WHERE organization_id = ?`, [org]).catch(() => {});
        await db.execute("DELETE FROM users WHERE organization_id = ? AND email LIKE 'cadence-api-%'", [org]).catch(() => {});
    }
}

async function api(method, path, { token = adminToken, body } = {}) {
    const res = await fetch(`${base}/api/ase${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

async function makeLead(org, tag, extra = {}) {
    const phone = `+91910000${String(Math.floor(Math.random() * 9000) + 1000)}`;
    return Lead.create({
        organization_id: org,
        name: `Asha ${tag}`,
        first_name: "Asha",
        email: `cadence.api.${tag}.${Date.now()}@example.com`,
        company: `Beta ${tag} Foods`,
        phone,
        phone_e164: phone,
        phone_validation: "VALID",
        voice_consent: { status: "GRANTED" },
        email_consent: { status: "GRANTED" },
        status: "NEW",
        ...extra,
    });
}

async function insertUser(role, tag) {
    const result = await db.execute(
        "INSERT INTO users (organization_id, role, fullName, organization, email, authProvider) VALUES (?, ?, ?, ?, ?, 'local')",
        [ORG, role, `Cadence ${tag}`, "Cadence Test Org", `cadence-api-${tag}-${Date.now()}@example.com`]
    );
    return result.insertId;
}

describe("Cadence HTTP API (live DB)", () => {
    before(async () => {
        db = await import("../config/db.js");
        await db.connectDb();
        ({ Lead } = await import("../models/lead.model.js"));
        ({ CadenceStep } = await import("../models/ase-cadence.model.js"));
        const { env } = await import("../config/env.js");
        const jwt = (await import("jsonwebtoken")).default;
        const { seedOperatingMode } = await import("../services/ase/operatingMode.service.js");
        seedOperatingMode(ORG, "FULLY_AUTOMATED");
        await cleanup();
        adminToken = jwt.sign({ sub: String(await insertUser("ORG_ADMIN", "admin")) }, env.jwtSecret, { expiresIn: "10m" });
        repToken = jwt.sign({ sub: String(await insertUser("SALESPERSON", "rep")) }, env.jwtSecret, { expiresIn: "10m" });
        const { app } = await import("../app.js");
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await cleanup();
        await new Promise((resolve) => server?.close(resolve));
        await db.closeDb();
    });

    test("policy endpoints: default auto-created, invalid settings rejected, rep cannot edit", async () => {
        const list = await api("GET", "/cadence/policies");
        assert.equal(list.status, 200);
        assert.equal(list.json.data.length, 1);
        const policy = list.json.data[0];
        assert.equal(policy.is_default, true);
        assert.equal(policy.settings.retryIntervalMinutes, 120);

        const bad = await api("PUT", `/cadence/policies/${policy.id}`, { body: { settings: { voicemailAction: "SING" } } });
        assert.equal(bad.status, 422);
        assert.ok(bad.json.details.errors.length);

        const forbidden = await api("PUT", `/cadence/policies/${policy.id}`, { token: repToken, body: { settings: {} } });
        assert.equal(forbidden.status, 403);

        const allDay = { startHour: 0, endHour: 24, days: [0, 1, 2, 3, 4, 5, 6] };
        const ok = await api("PUT", `/cadence/policies/${policy.id}`, { body: { settings: { callingWindow: allDay, emailWindow: allDay, emailAfterRetryDelayMinutes: 45 }, version: policy.version } });
        assert.equal(ok.status, 200);
        assert.equal(ok.json.data.settings.emailAfterRetryDelayMinutes, 45);
        assert.equal(ok.json.data.version, policy.version + 1);

        const stale = await api("PUT", `/cadence/policies/${policy.id}`, { body: { settings: {}, version: policy.version } });
        assert.equal(stale.status, 409, "optimistic version check");
    });

    test("eligibility, confirmation gate, enroll and controls", async () => {
        const noConsent = await makeLead(ORG, "nc", { email_consent: null });
        const elig = await api("GET", `/cadence/leads/${noConsent.id}/eligibility`);
        assert.equal(elig.status, 200);
        assert.equal(elig.json.data.eligibility.result, "ELIGIBLE");
        assert.equal(elig.json.data.eligibility.channels.email, false);

        const missingCountry = await makeLead(ORG, "mc", { phone: "9876501234", phone_e164: null, phone_validation: "MISSING_COUNTRY" });
        const needs = await api("POST", `/cadence/leads/${missingCountry.id}/enroll`, { body: {} });
        assert.equal(needs.status, 409);
        assert.equal(needs.json.data.requiresConfirmation, true);

        const lead = await makeLead(ORG, "ok");
        const enrolled = await api("POST", `/cadence/leads/${lead.id}/enroll`, { token: repToken, body: { startNow: true } });
        assert.equal(enrolled.status, 200);
        assert.equal(enrolled.json.data.enrolled, true);
        const again = await api("POST", `/cadence/leads/${lead.id}/enroll`, { body: {} });
        assert.equal(again.json.data.reason, "ALREADY_ENROLLED");

        let state;
        for (let i = 0; i < 60; i += 1) {
            state = await api("GET", `/cadence/leads/${lead.id}`);
            if (state.json.data.nextStep?.step_key === "call:2") break;
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        assert.equal(state.status, 200);
        assert.equal(state.json.data.open, true);
        assert.ok(state.json.data.steps.some((s) => s.step_key === "call:1" && s.status === "DONE"), "first call executed in background");
        assert.equal(state.json.data.nextStep.step_key, "call:2");

        assert.equal((await api("POST", `/cadence/leads/${lead.id}/pause`, { body: { reason: "Rep wants to wait" } })).status, 200);
        assert.equal((await api("POST", `/cadence/leads/${lead.id}/pause`, {})).status, 409);
        const resumed = await api("POST", `/cadence/leads/${lead.id}/resume`, {});
        assert.equal(resumed.status, 200);
        assert.equal(resumed.json.data.status, "ACTIVE");

        const queue = await api("GET", "/cadence/queue?filter=retry_due");
        assert.equal(queue.status, 200);
        assert.ok(queue.json.data.items.some((row) => Number(row.lead_id) === Number(lead.id)));
        assert.equal((await api("GET", "/cadence/queue?filter=bogus")).status, 400);

        assert.equal((await api("POST", `/cadence/leads/${lead.id}/stop`, { body: { reason: "Done" } })).status, 200);
        assert.equal((await api("POST", `/cadence/leads/${lead.id}/stop`, {})).status, 404);
    });

    test("orphan recovery: a step closed before its decision is replanned exactly once", async () => {
        const { enrollLead, replanOrphan } = await import("../services/ase/cadence/cadence.service.js");
        const { CadenceEnrollment } = await import("../models/ase-cadence.model.js");
        const lead = await makeLead(ORG, "orphan");
        const { enrollment } = await enrollLead(ORG, lead.id, { startNow: false });
        const call1 = await CadenceStep.findByKey(enrollment.id, "call:1");
        assert.ok(await CadenceStep.claim(ORG, call1.id));
        await CadenceStep.transition(ORG, call1.id, {
            fromStatuses: ["EXECUTING"],
            patch: { status: "DONE", channel_state: "NO_ANSWER", result: { result: "NO_ANSWER" }, completed_at: new Date() },
        });
        await CadenceEnrollment.transition(ORG, enrollment.id, { patch: { last_event_at: new Date(Date.now() - 10 * 60 * 1000) } });

        const orphans = await CadenceEnrollment.findOrphaned(new Date(Date.now() - 5 * 60 * 1000), 500);
        assert.ok(orphans.some((o) => o.id === Number(enrollment.id)), "detected as orphan");
        assert.equal(await replanOrphan(ORG, enrollment.id), true);
        assert.equal(await replanOrphan(ORG, enrollment.id), false, "second recovery is a no-op");
        const next = await CadenceStep.findNextOpen(ORG, enrollment.id);
        assert.equal(next.step_key, "call:2");
        const gapMinutes = (new Date(next.due_at) - new Date()) / 60000;
        assert.ok(gapMinutes > 100 && gapMinutes <= 121, `retry ~2h out, got ${gapMinutes}`);
    });

    test("tenant isolation: another org's lead is not visible", async () => {
        const foreign = await makeLead(OTHER_ORG, "foreign");
        const res = await api("GET", `/cadence/leads/${foreign.id}/eligibility`);
        assert.equal(res.status, 404);
        const enroll = await api("POST", `/cadence/leads/${foreign.id}/enroll`, { body: {} });
        assert.equal(enroll.status, 404);
    });

    test("unauthenticated requests are rejected", async () => {
        const res = await fetch(`${base}/api/ase/cadence/queue`);
        assert.equal(res.status, 401);
    });
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { app } from "../app.js";
import { closeDb, connectDb, query, execute } from "../config/db.js";
import { env } from "../config/env.js";
import { Lead } from "../models/lead.model.js";
import { Suppression } from "../models/suppression.model.js";
import { rotateLeadApiKey } from "../services/leads/leadApiCredential.service.js";

process.env.ASE_SKIP_OUTREACH = "1";

const ORG = Number(env.leadsApiOrgId || 1);
let server;
let base;
let originalSettings = null;

const headers = (extra = {}) => ({
    "content-type": "application/json",
    "x-api-key": env.leadsApiKey,
    ...extra,
});

async function post(path, body, extraHeaders = {}, raw = null) {
    const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: raw == null ? headers(extraHeaders) : { "content-type": "application/json", ...extraHeaders },
        body: raw == null ? JSON.stringify(body) : raw,
    });
    const text = await response.text();
    let payload = {};
    try {
        payload = text ? JSON.parse(text) : {};
    } catch {
        payload = { raw: text };
    }
    return { status: response.status, payload };
}

before(async () => {
    await connectDb();
    const rows = await query("SELECT settings FROM organizations WHERE id = ? LIMIT 1", [ORG]);
    originalSettings = rows[0]?.settings ?? "{}";
    if (typeof originalSettings !== "string") originalSettings = JSON.stringify(originalSettings);
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (originalSettings != null) {
        await execute("UPDATE organizations SET settings = ? WHERE id = ?", [originalSettings, ORG]);
    }
    await execute("DELETE FROM leads WHERE email LIKE '%@capture%.example'");
    await execute(
        "DELETE FROM suppressions WHERE organization_id = ? AND value LIKE '%@capture%.example'",
        [ORG]
    );
    if (server) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
    await closeDb();
});

test("valid single lead is created and is not contacted without consent", async () => {
    const email = "single@capture-single.example";
    const result = await post("/api/leads", {
        email,
        name: "Single Lead",
        company: "Single Co",
        phone: "+14155551001",
    });
    assert.equal(result.status, 201);
    assert.equal(result.payload.data.status, "created");
    assert.equal(result.payload.data.lead.status, "NEW");
    assert.equal(result.payload.data.lead.next_action, null);
    assert.equal(result.payload.data.outreachStatus, "held_for_consent");
    assert.equal(result.payload.data.lead.email_consent.status, "UNKNOWN");
});

test("valid batch reports accepted records", async () => {
    const result = await post("/api/leads", {
        leads: [
            { email: "a@capture-batch-a.example", name: "Batch A", consentEmail: true },
            { email: "b@capture-batch-b.example", name: "Batch B", consentEmail: true },
        ],
    });
    assert.equal(result.status, 200);
    assert.equal(result.payload.data.accepted, 2);
    assert.equal(result.payload.data.created, 2);
    assert.equal(result.payload.data.rejected, 0);
});

test("webhook payload wrapper is accepted", async () => {
    const result = await post("/api/leads/webhook", {
        source: "API",
        payload: {
            email: "hook@capture-webhook.example",
            name: "Webhook Lead",
            consentEmail: true,
        },
    });
    assert.equal(result.status, 201);
    assert.equal(result.payload.data.lead.email, "hook@capture-webhook.example");
    assert.equal(result.payload.data.lead.source, "API");
});

test("missing and invalid API keys are rejected", async () => {
    const missing = await post("/api/leads", { email: "missing@capture-auth.example" }, { "x-api-key": "" });
    const invalid = await fetch(`${base}/api/leads`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "not-the-key" },
        body: JSON.stringify({ email: "bad@capture-auth.example" }),
    });
    assert.equal(missing.status, 401);
    assert.equal(invalid.status, 401);
});

test("mismatched organization header is rejected", async () => {
    const result = await post(
        "/api/leads",
        { email: "org@capture-org.example" },
        { "x-organization-id": "999" }
    );
    assert.equal(result.status, 403);
    const stored = await Lead.findByEmail(ORG, "org@capture-org.example");
    assert.equal(stored, null);
});

test("invalid email, phone, and missing email are rejected", async () => {
    const email = await post("/api/leads", { email: "not-an-email" });
    const phone = await post("/api/leads", { email: "phone@capture-invalid.example", phone: "123" });
    const missing = await post("/api/leads", { name: "No Email" });
    assert.equal(email.status, 400);
    assert.equal(phone.status, 400);
    assert.match(phone.payload.error, /Invalid phone/);
    assert.equal(missing.status, 400);
    assert.match(missing.payload.error, /Email is required/);
});

test("duplicate email, phone, and company domain are detected", async () => {
    const email = "dup@capture-email.example";
    const first = await post("/api/leads", { email, name: "First", phone: "+14155551002" });
    const again = await post("/api/leads", { email, name: "Second" });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.payload.data.status, "skipped");

    const phoneA = await post("/api/leads", { email: "p1@capture-phone-a.example", phone: "+14155551003" });
    const phoneB = await post("/api/leads", { email: "p2@capture-phone-b.example", phone: "+1 (415) 555-1003" });
    assert.equal(phoneA.status, 201);
    assert.equal(phoneB.status, 200);
    assert.equal(phoneB.payload.data.status, "skipped");

    const domainA = await post("/api/leads", { email: "d1@capture-domain.example", name: "Domain One" });
    const domainB = await post("/api/leads", { email: "d2@capture-domain.example", name: "Domain Two" });
    assert.equal(domainA.status, 201);
    assert.equal(domainB.status, 200);
    assert.equal(domainB.payload.data.status, "skipped");
    assert.equal(domainB.payload.data.lead.email, "d1@capture-domain.example");
});

test("updateExisting refreshes profile fields and keeps lifecycle and consent", async () => {
    const email = "update@capture-update.example";
    const created = await post("/api/leads", { email, name: "Before", consentEmail: true });
    const id = created.payload.data.lead.id;
    await Lead.updateById(id, {
        status: "ENGAGED",
        email_consent: { status: "DENIED", source: "UNSUBSCRIBE", timestamp: "2026-01-01T00:00:00.000Z" },
        do_not_contact: 1,
        attempt_counters: { email: 2, voice: 1, total: 3 },
        next_action: "CALL",
        disposition: "INTERESTED",
    }, ORG);

    const updated = await post("/api/leads", {
        email,
        name: "After",
        company: "Updated Co",
        updateExisting: true,
        consentEmail: true,
        do_not_contact: 0,
        status: "NEW",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.payload.data.status, "updated");
    const lead = await Lead.findById(id, ORG);
    assert.equal(lead.name, "After");
    assert.equal(lead.company, "Updated Co");
    assert.equal(lead.status, "ENGAGED");
    assert.equal(lead.email_consent.status, "DENIED");
    assert.equal(Number(lead.do_not_contact), 1);
    assert.equal(lead.attempt_counters.email, 2);
    assert.equal(lead.next_action, "CALL");
    assert.equal(lead.disposition, "INTERESTED");
});

test("suppressed email is stored as do-not-contact and is not queued", async () => {
    const email = "dnc@capture-dnc.example";
    await Suppression.add(ORG, "EMAIL", email, "test suppression");
    const result = await post("/api/leads", { email, name: "Suppressed", consentEmail: true });
    assert.equal(result.status, 201);
    assert.equal(result.payload.data.lead.status, "SUPPRESSED_DNC");
    assert.equal(Number(result.payload.data.lead.do_not_contact), 1);
    assert.equal(result.payload.data.lead.next_action, null);
    assert.equal(result.payload.data.outreachStatus, undefined);
});

test("concurrent duplicate posts create one lead", async () => {
    const email = "race@capture-race.example";
    const results = await Promise.all(
        Array.from({ length: 8 }, () => post("/api/leads", { email, name: "Race", phone: "+14155551008" }))
    );
    const created = results.filter((item) => item.payload.data?.status === "created");
    const skipped = results.filter((item) => item.payload.data?.status === "skipped" || item.payload.data?.status === "updated");
    assert.equal(created.length, 1);
    assert.equal(created.length + skipped.length, 8);
    const rows = await query("SELECT id FROM leads WHERE organization_id = ? AND email = ?", [ORG, email]);
    assert.equal(rows.length, 1);
});

test("oversized batch and malformed JSON are rejected", async () => {
    const oversized = await post("/api/leads", {
        leads: Array.from({ length: 5001 }, (_, index) => ({ email: `row${index}@capture-oversize.example` })),
    });
    assert.equal(oversized.status, 413);
    const stored = await Lead.findByEmail(ORG, "row0@capture-oversize.example");
    assert.equal(stored, null);

    const malformed = await post("/api/leads", null, {}, "{");
    assert.equal(malformed.status, 400);

    const partial = await post("/api/leads", {
        leads: [
            { email: "good@capture-partial.example", name: "Good" },
            { email: "bad-email", name: "Bad" },
        ],
    });
    assert.equal(partial.status, 207);
    assert.equal(partial.payload.data.accepted, 1);
    assert.equal(partial.payload.data.rejected, 1);
    assert.equal(partial.payload.data.errors.length, 1);
});

test("rotated key replaces the previous key and can be restored", async () => {
    const rotated = await rotateLeadApiKey();
    assert.match(rotated.apiKey, /^ase_[a-f0-9]{48}$/);
    const oldKey = await fetch(`${base}/api/leads`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.leadsApiKey },
        body: JSON.stringify({ email: "old@capture-rotate.example" }),
    });
    const newKey = await fetch(`${base}/api/leads`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": rotated.apiKey },
        body: JSON.stringify({ email: "new@capture-rotate.example" }),
    });
    assert.equal(oldKey.status, 401);
    assert.equal(newKey.status, 201);
    const settings = await query("SELECT settings FROM organizations WHERE id = ? LIMIT 1", [ORG]);
    const parsed = typeof settings[0].settings === "string" ? JSON.parse(settings[0].settings) : settings[0].settings;
    assert.equal(parsed.leadApiKey.hash.startsWith("scrypt:"), true);
    assert.equal(JSON.stringify(parsed).includes(rotated.apiKey), false);
});

test("vite proxies /api to the backend and the public URL is not the frontend port", () => {
    const vite = readFileSync(new URL("../../../frontend/vite.config.js", import.meta.url), "utf8");
    assert.match(vite, /proxy:\s*\{[\s\S]*"\/api"/);
    assert.match(vite, /http:\/\/localhost:3001/);
    const displayed = env.publicApiUrl || "http://localhost:3001";
    assert.equal(displayed.includes(":5173"), false);
});

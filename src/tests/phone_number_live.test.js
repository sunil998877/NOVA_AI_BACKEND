import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { env } from "../config/env.js";
import { connectDb, closeDb, execute } from "../config/db.js";
import { Lead } from "../models/lead.model.js";

const BASE = `http://127.0.0.1:${env.port || 3001}`;
const stamp = Date.now();
const emails = [];

async function postLead(body) {
    const response = await fetch(`${BASE}/api/leads`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-api-key": env.leadsApiKey,
        },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (body.email) emails.push(body.email);
    return { status: response.status, payload };
}

before(async () => {
    await connectDb();
});

after(async () => {
    for (const email of emails) {
        await execute("DELETE FROM leads WHERE email = ?", [email]).catch(() => {});
    }
    await closeDb();
});

test("live ingest: Indian, UK, US, French numbers save as E.164 with country", async () => {
    const cases = [
        { email: `in-${stamp}@phone-live.example`, phone: "+91 98765 43210", country: "IN", e164: "+919876543210" },
        { email: `gb-${stamp}@phone-live.example`, phone: "+44 20 7946 0958", country: "GB", e164: "+442079460958" },
        { email: `us-${stamp}@phone-live.example`, phone: "+1 (800) 555-0199", country: "US", e164: "+18005550199" },
        { email: `fr-${stamp}@phone-live.example`, phone: "+33 1 23 45 67 89", country: "FR", e164: "+33123456789" },
    ];
    for (const sample of cases) {
        const result = await postLead({
            email: sample.email,
            name: sample.country,
            phone: sample.phone,
            source: "API",
            matchDomain: false,
        });
        assert.equal(result.status, 201, sample.email);
        const lead = result.payload.data.lead;
        assert.equal(lead.phone, sample.e164);
        assert.equal(lead.phone_country, sample.country);
        assert.equal(lead.phone_e164, sample.e164);
        assert.ok(lead.phone_calling_code);
        assert.ok(["VALID", "POSSIBLE"].includes(lead.phone_validation), lead.phone_validation);
    }
});

test("live ingest: national number without country is rejected", async () => {
    const result = await postLead({
        email: `missing-${stamp}@phone-live.example`,
        phone: "9876543210",
        matchDomain: false,
    });
    assert.equal(result.status, 400);
    assert.equal(result.payload.field, "phone");
    assert.equal(result.payload.code, "PHONE_MISSING_COUNTRY");
});

test("live ingest: national number with country column normalizes", async () => {
    const result = await postLead({
        email: `in-national-${stamp}@phone-live.example`,
        phone: "7001234567",
        country: "India",
        matchDomain: false,
    });
    assert.equal(result.status, 201);
    assert.equal(result.payload.data.lead.phone, "+917001234567");
    assert.equal(result.payload.data.lead.phone_country, "IN");
});

test("live ingest: formatted US duplicate is skipped", async () => {
    const phone = "+14155551001";
    const first = await postLead({
        email: `dup-a-${stamp}@phone-live.example`,
        phone,
        matchDomain: false,
    });
    const second = await postLead({
        email: `dup-b-${stamp}@phone-live.example`,
        phone: "+1 (415) 555-1001",
        matchDomain: false,
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.payload.data.status, "skipped");
});

test("live findByPhone matches equivalent formats", async () => {
    const email = `lookup-${stamp}@phone-live.example`;
    const created = await postLead({ email, phone: "+61 412 345 678", matchDomain: false });
    assert.equal(created.status, 201);
    const stored = await Lead.findByPhone(env.leadsApiOrgId, "0412 345 678");
    assert.ok(stored);
    assert.equal(stored.phone, "+61412345678");
});

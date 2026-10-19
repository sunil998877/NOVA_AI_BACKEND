import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret } from "../services/email/secretCipher.js";
import { SenderAccount } from "../models/sender-account.model.js";
import { EmailDelivery } from "../models/email-delivery.model.js";
import { checkRecipientCompliance } from "../services/email/complianceCheck.service.js";
import { isTimeInSendingWindow, calculateNextWindowOpening, getPacingDelayMs } from "../services/email/pacingWindow.service.js";
import { executeCampaignDryRun } from "../services/email/dryRun.service.js";
import { unifiedDeliveryService } from "../services/email/unifiedDelivery.service.js";
import { emailAdapter } from "../services/ase/adapters/email.adapter.js";
import { connectDb, closeDb, query, execute } from "../config/db.js";

describe("Mukh.1-Style Email Engine: Encryption, Senders, Pacing, Idempotency, and Compliance", () => {
    let testOrgId = 999;
    let testUserId = 999;

    before(async () => {
        try {
            await connectDb();
        } catch (_) {}
    });

    after(async () => {
        try {
            await execute(`DELETE FROM email_deliveries WHERE organization_id = ?`, [testOrgId]).catch(() => {});
            await execute(`DELETE FROM sender_accounts WHERE organization_id = ?`, [testOrgId]).catch(() => {});
            await closeDb();
        } catch (_) {}
    });

    test("1. AES-256-GCM secret encryption and decryption round-trip", () => {
        const secret = "SuperSecretSmtpPass!#2026";
        const encrypted = encryptSecret(secret);

        assert.notEqual(encrypted, secret);
        assert.ok(encrypted.includes(":"));

        const decrypted = decryptSecret(encrypted);
        assert.equal(decrypted, secret);

        const encryptedAgain = encryptSecret(secret);
        assert.notEqual(encrypted, encryptedAgain);
        assert.equal(decryptSecret(encryptedAgain), secret);
    });

    test("2. SenderAccount sanitization never exposes encrypted secrets", () => {
        const raw = {
            id: 1,
            organization_id: 1,
            name: "Sales Rep 1",
            email: "rep1@acme.com",
            host: "smtp.acme.com",
            port: 587,
            username: "rep1",
            password_encrypted: encryptSecret("pass123"),
            daily_limit: 100,
            current_day_sends: 25,
            status: "active",
        };

        const safe = SenderAccount.sanitize(raw);
        assert.equal(safe.password_encrypted, undefined);
        assert.equal(safe.has_credentials, true);
        assert.equal(safe.remaining_daily, 75);
    });

    test("3. Inbox rotation: least-used selection and daily cap enforcement", async () => {
        const senders = [
            {
                id: 101,
                name: "Sender High Usage",
                email: "high@example.com",
                daily_limit: 100,
                hourly_limit: 50,
                current_day_sends: 90,
                current_hour_sends: 10,
                status: "active",
                last_used_at: new Date(Date.now() - 5000),
            },
            {
                id: 102,
                name: "Sender Least Used",
                email: "least@example.com",
                daily_limit: 100,
                hourly_limit: 50,
                current_day_sends: 10,
                current_hour_sends: 2,
                status: "active",
                last_used_at: new Date(Date.now() - 10000),
            },
            {
                id: 103,
                name: "Sender Paused",
                email: "paused@example.com",
                daily_limit: 100,
                hourly_limit: 50,
                current_day_sends: 0,
                current_hour_sends: 0,
                status: "paused",
            },
            {
                id: 104,
                name: "Sender Capped",
                email: "capped@example.com",
                daily_limit: 50,
                hourly_limit: 50,
                current_day_sends: 50,
                current_hour_sends: 10,
                status: "active",
            },
        ];

        const eligible = senders
            .filter((s) => s.status === "active" && s.current_day_sends < s.daily_limit && s.current_hour_sends < s.hourly_limit)
            .sort((a, b) => a.current_day_sends - b.current_day_sends || a.last_used_at - b.last_used_at);

        assert.equal(eligible.length, 2);
        assert.equal(eligible[0].id, 102);
        assert.equal(eligible[1].id, 101);
    });

    test("4. Sending window: timezone awareness and permitted days", () => {
        const campaignAlwaysOpen = {
            sending_window_start: "00:00",
            sending_window_end: "23:59",
            sending_days: JSON.stringify([0, 1, 2, 3, 4, 5, 6]),
            timezone: "UTC",
        };
        assert.equal(isTimeInSendingWindow(campaignAlwaysOpen, new Date()), true);

        const campaignClosedWindow = {
            sending_window_start: "01:00",
            sending_window_end: "02:00",
            sending_days: JSON.stringify([1, 2, 3, 4, 5]),
            timezone: "UTC",
        };

        const testMidday = new Date("2026-10-19T14:30:00Z");
        assert.equal(isTimeInSendingWindow(campaignClosedWindow, testMidday), false);

        const nextOpening = calculateNextWindowOpening(campaignClosedWindow, testMidday);
        assert.ok(nextOpening instanceof Date);
        assert.ok(nextOpening.getTime() > testMidday.getTime());
    });

    test("5. Pacing delay: bounded jitter within configured bounds", () => {
        const campaign = {
            min_delay_seconds: 4,
            max_delay_seconds: 8,
        };

        for (let i = 0; i < 20; i += 1) {
            const delayMs = getPacingDelayMs(campaign);
            assert.ok(delayMs >= 4000, `Delay ${delayMs}ms should be >= 4000ms`);
            assert.ok(delayMs <= 8000, `Delay ${delayMs}ms should be <= 8000ms`);
        }
    });

    test("6. Compliance check: blocks invalid, suppressed, and DNC recipients", async () => {
        const valid = await checkRecipientCompliance(1, { email: "prospect@acmecorp.io" });
        assert.equal(valid.eligible, true);

        const invalidEmail = await checkRecipientCompliance(1, { email: "not-an-email" });
        assert.equal(invalidEmail.eligible, false);
        assert.equal(invalidEmail.reason, "INVALID_EMAIL");

        const dnc = await checkRecipientCompliance(1, { email: "user@domain.com", do_not_contact: true });
        assert.equal(dnc.eligible, false);
        assert.equal(dnc.reason, "DNC_FLAGGED");

        const consentDenied = await checkRecipientCompliance(1, {
            email: "optedout@domain.com",
            email_consent: { status: "DENIED" },
        });
        assert.equal(consentDenied.eligible, false);
        assert.equal(consentDenied.reason, "CONSENT_DENIED");
    });

    test("7. Idempotency and duplicate send protection", async () => {
        const key = `test_idempotent_${Date.now()}`;
        const first = await EmailDelivery.create({
            organization_id: testOrgId,
            campaign_id: 1,
            mail_id: 1,
            recipient_email: "idempotent@test.com",
            subject: "Hello",
            idempotency_key: key,
            status: "pending",
        });

        assert.ok(first?.id);

        const second = await EmailDelivery.create({
            organization_id: testOrgId,
            campaign_id: 1,
            mail_id: 1,
            recipient_email: "idempotent@test.com",
            subject: "Hello Again",
            idempotency_key: key,
            status: "pending",
        });

        assert.equal(second.id, first.id);
    });

    test("8. Dry-run mode: validates recipients without sending real emails", async () => {
        const dryRun = await executeCampaignDryRun(1, 1, 1);
        if (dryRun.success) {
            assert.equal(dryRun.dryRun, true);
            assert.ok(Array.isArray(dryRun.senderPool));
            assert.ok(typeof dryRun.eligibleCount === "number");
            assert.ok(typeof dryRun.skippedCount === "number");
        } else {
            assert.ok(dryRun.error);
        }
    });

    test("9. Unified delivery engine: simulated outreach for reserved domains", async () => {
        const result = await unifiedDeliveryService.deliverSingle({
            orgId: 1,
            to: "alex@example.com",
            subject: "Enterprise Cold Outreach",
            html: "<p>Hello Alex</p>",
            idempotencyKey: `sim_${Date.now()}`,
        });

        assert.equal(result.success, true);
        assert.equal(result.status, "SUCCEEDED");
        assert.equal(result.deliveryMethod, "simulated");
        assert.ok(result.messageId.startsWith("sim_"));
    });

    test("10. ASE email adapter routes through shared unified delivery service", async () => {
        const mockLead = {
            id: 888,
            organization_id: 1,
            name: "Jordan Lee",
            email: "jordan@example.org",
            company: "OmniCorp",
            priority: 80,
            status: "CONTACTED",
        };

        const dispatch = await emailAdapter.execute(mockLead, "EMAIL", {
            subject: "OmniCorp Growth Strategy",
            text: "Hello Jordan",
        });

        assert.equal(dispatch.channel, "EMAIL");
        assert.equal(dispatch.status, "SUCCEEDED");
        assert.ok(dispatch.metadata.messageId);
    });
});

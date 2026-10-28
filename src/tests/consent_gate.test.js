import { test } from "node:test";
import assert from "node:assert/strict";
import {
    CONSENT_STATUSES,
    CONSENT_SOURCES,
    buildConsentRecord,
    consentFromIntake,
    isConsentGranted,
    consentBlockReason,
    normalizeConsentSource,
} from "../services/ase/consent.service.js";
import { normalizeLead } from "../services/leads/leadIntake.service.js";

test("intake defaults consent to UNKNOWN and never treats it as GRANTED", () => {
    const lead = normalizeLead({ email: "unknown@consent.example", name: "Pat" });
    assert.equal(lead.email_consent.status, CONSENT_STATUSES.UNKNOWN);
    assert.equal(lead.voice_consent.status, CONSENT_STATUSES.UNKNOWN);
    assert.equal(isConsentGranted(lead.email_consent), false);
    assert.equal(consentFromIntake(null, true, "CSV_IMPORT").status, CONSENT_STATUSES.GRANTED);
    assert.equal(consentFromIntake(null, true, "CSV_IMPORT").source, CONSENT_SOURCES.IMPORT);
});

test("UNKNOWN email consent cannot dispatch autonomous email", () => {
    const unknownLead = { email: "unknown@consent.example", email_consent: { status: "UNKNOWN" } };
    assert.equal(isConsentGranted(unknownLead.email_consent), false);
    assert.equal(consentBlockReason(unknownLead, "EMAIL"), "Email consent has not been granted");
    assert.equal(consentBlockReason({ email_consent: { status: "GRANTED" } }, "EMAIL"), null);
});

test("consent sources map to import / reply / form / api", () => {
    assert.equal(normalizeConsentSource("CSV_IMPORT"), CONSENT_SOURCES.IMPORT);
    assert.equal(normalizeConsentSource("unsubscribe"), CONSENT_SOURCES.REPLY);
    assert.equal(normalizeConsentSource("UI"), CONSENT_SOURCES.FORM);
    assert.equal(buildConsentRecord({ status: "yes", source: "form" }).status, CONSENT_STATUSES.GRANTED);
    assert.equal(consentBlockReason({ voice_consent: { status: "UNKNOWN" } }, "CALL"), "Voice consent has not been granted");
});

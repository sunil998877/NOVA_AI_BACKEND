import { test } from "node:test";
import assert from "node:assert/strict";
import {
    PHONE_STATUSES,
    assertPhoneOrEmpty,
    listCountries,
    parsePhoneInput,
    phoneDigitKeys,
    phoneLookupKeys,
    resolveCountry,
} from "../services/leads/phoneNumber.service.js";
import { autoDetectMapping, csvToLeads } from "../services/leads/csvParser.js";
import { normalizeLead } from "../services/leads/leadIntake.service.js";

test("country list comes from library metadata, not a hardcoded map", () => {
    const countries = listCountries();
    assert.ok(countries.length > 50);
    const isos = new Set(countries.map((row) => row.iso));
    for (const iso of ["IN", "GB", "DE", "FR", "US", "CA", "AU"]) {
        assert.ok(isos.has(iso), `missing ${iso}`);
    }
    assert.equal(resolveCountry("India").iso, "IN");
    assert.equal(resolveCountry("GB").iso, "GB");
    assert.equal(resolveCountry("United States").iso, "US");
    assert.equal(resolveCountry("1").status, PHONE_STATUSES.AMBIGUOUS);
});

test("international numbers normalize to E.164 with detected country", () => {
    const samples = [
        { raw: "+91 98765 43210", country: "IN", e164: "+919876543210" },
        { raw: "+44 20 7946 0958", country: "GB", e164: "+442079460958" },
        { raw: "+49 30 123456", country: "DE", e164: "+4930123456" },
        { raw: "+33 1 23 45 67 89", country: "FR", e164: "+33123456789" },
        { raw: "+1 (800) 555-0199", country: "US", e164: "+18005550199" },
        { raw: "+1 (604) 555-0100", country: "CA", e164: "+16045550100" },
        { raw: "+61 412 345 678", country: "AU", e164: "+61412345678" },
    ];
    for (const sample of samples) {
        const parsed = parsePhoneInput(sample.raw);
        assert.equal(parsed.e164, sample.e164, sample.raw);
        assert.equal(parsed.country, sample.country, sample.raw);
        assert.ok(
            parsed.status === PHONE_STATUSES.VALID || parsed.status === PHONE_STATUSES.POSSIBLE,
            `${sample.raw} status ${parsed.status}`
        );
        assert.ok(parsed.callingCode);
        assert.ok(parsed.countryName);
    }
});

test("00 prefix, spaces, and brackets are stripped before parse", () => {
    const parsed = parsePhoneInput("00 49 (30) 123456");
    assert.equal(parsed.e164, "+4930123456");
    assert.equal(parsed.country, "DE");
});

test("national numbers require a country and are not guessed as India", () => {
    const missing = parsePhoneInput("9876543210");
    assert.equal(missing.status, PHONE_STATUSES.MISSING_COUNTRY);
    assert.equal(missing.e164, null);

    const indian = parsePhoneInput("9876543210", { defaultCountry: "IN" });
    assert.equal(indian.e164, "+919876543210");
    assert.equal(indian.country, "IN");

    const uk = parsePhoneInput("07700900123", { explicitCountry: "United Kingdom" });
    assert.equal(uk.e164, "+447700900123");
});

test("invalid, empty, and conflicting numbers are flagged", () => {
    assert.equal(parsePhoneInput("").status, PHONE_STATUSES.EMPTY);
    assert.equal(parsePhoneInput("123", { defaultCountry: "US" }).status, PHONE_STATUSES.INVALID);

    const conflict = parsePhoneInput("+442079460958", { explicitCountry: "IN" });
    assert.equal(conflict.status, PHONE_STATUSES.CONFLICT);
    assert.equal(conflict.callingCode, "44");

    const confirmed = parsePhoneInput("+442079460958", { explicitCountry: "IN", confirmConflict: true });
    assert.equal(confirmed.e164, "+442079460958");
    assert.ok(confirmed.status === PHONE_STATUSES.VALID || confirmed.status === PHONE_STATUSES.POSSIBLE);
});

test("assertPhoneOrEmpty throws structured errors and accepts empty", () => {
    const empty = assertPhoneOrEmpty("  ");
    assert.equal(empty.status, PHONE_STATUSES.EMPTY);
    try {
        assertPhoneOrEmpty("07700900123");
        assert.fail("expected throw");
    } catch (error) {
        assert.equal(error.field, "phone");
        assert.equal(error.code, "PHONE_MISSING_COUNTRY");
        assert.equal(error.details.status, PHONE_STATUSES.MISSING_COUNTRY);
    }
});

test("lookup keys treat formatted and E.164 numbers as equivalent", () => {
    const keys = phoneLookupKeys("+1 (800) 555-0199");
    assert.ok(keys.includes("+18005550199"));
    assert.ok(keys.includes("18005550199"));

    const auKeys = phoneLookupKeys("0412 345 678");
    assert.ok(auKeys.includes("0412345678"));
    assert.ok(auKeys.includes("412345678"));
    assert.ok(phoneDigitKeys("0412 345 678").includes("412345678"));
});

test("CSV country column and mixed-country import preview stay explicit", () => {
    const mapping = autoDetectMapping(["Email", "Phone", "Country"]);
    assert.equal(mapping.email, 0);
    assert.equal(mapping.phone, 1);
    assert.equal(mapping.country, 2);
    const { leads } = csvToLeads("Email,Phone,Country\na@x.com,9876543210,India\nb@x.com,+442079460958,United Kingdom\n");
    const india = parsePhoneInput(leads[0].phone, { explicitCountry: leads[0].country });
    const uk = parsePhoneInput(leads[1].phone, { explicitCountry: leads[1].country });
    assert.equal(india.e164, "+919876543210");
    assert.equal(uk.country, "GB");
    const mixed = csvToLeads("Email,Phone\nc@x.com,9876543210\n");
    const flagged = parsePhoneInput(mixed.leads[0].phone);
    assert.equal(flagged.status, PHONE_STATUSES.MISSING_COUNTRY);
});

test("intake stores E.164 and country fields", () => {
    const lead = normalizeLead({
        email: "phone@intake.example",
        phone: "+33 1 23 45 67 89",
    });
    assert.equal(lead.phone, "+33123456789");
    assert.equal(lead.phone_country, "FR");
    assert.equal(lead.phone_calling_code, "33");
    assert.equal(lead.phone_original, "+33 1 23 45 67 89");
});

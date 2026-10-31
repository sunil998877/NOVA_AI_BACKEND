import parsePhoneNumberFromString, {
    getCountries,
    getCountryCallingCode,
} from "libphonenumber-js";

export const PHONE_STATUSES = Object.freeze({
    EMPTY: "EMPTY",
    VALID: "VALID",
    POSSIBLE: "POSSIBLE",
    INVALID: "INVALID",
    MISSING_COUNTRY: "MISSING_COUNTRY",
    AMBIGUOUS: "AMBIGUOUS",
    CONFLICT: "CONFLICT",
});

const ACCEPTABLE = new Set([PHONE_STATUSES.VALID, PHONE_STATUSES.POSSIBLE]);

let countryCache = null;
let regionNames = null;

function displayNames() {
    if (!regionNames) {
        regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    }
    return regionNames;
}

export function listCountries() {
    if (countryCache) return countryCache;
    const names = displayNames();
    countryCache = getCountries()
        .map((iso) => {
            let callingCode = "";
            try {
                callingCode = String(getCountryCallingCode(iso));
            } catch {
                callingCode = "";
            }
            return {
                iso,
                name: names.of(iso) || iso,
                callingCode,
            };
        })
        .filter((row) => row.callingCode)
        .sort((a, b) => a.name.localeCompare(b.name));
    return countryCache;
}

export function countryName(iso) {
    if (!iso) return null;
    try {
        return displayNames().of(String(iso).toUpperCase()) || String(iso).toUpperCase();
    } catch {
        return String(iso).toUpperCase();
    }
}

export function resolveCountry(input) {
    const raw = String(input || "").trim();
    if (!raw) return { iso: null, status: PHONE_STATUSES.EMPTY, matches: [] };

    const countries = listCountries();
    const upper = raw.toUpperCase();
    const byIso = countries.find((row) => row.iso === upper);
    if (byIso) return { iso: byIso.iso, status: PHONE_STATUSES.VALID, matches: [byIso] };

    const digits = raw.replace(/[^\d]/g, "");
    if (digits && /^[1-9]\d{0,3}$/.test(digits)) {
        const matches = countries.filter((row) => row.callingCode === digits);
        if (matches.length === 1) return { iso: matches[0].iso, status: PHONE_STATUSES.VALID, matches };
        if (matches.length > 1) return { iso: null, status: PHONE_STATUSES.AMBIGUOUS, matches };
    }

    const lowered = raw.toLowerCase();
    const exact = countries.filter((row) => row.name.toLowerCase() === lowered);
    if (exact.length === 1) return { iso: exact[0].iso, status: PHONE_STATUSES.VALID, matches: exact };
    if (exact.length > 1) return { iso: null, status: PHONE_STATUSES.AMBIGUOUS, matches: exact };

    const partial = countries.filter((row) => row.name.toLowerCase().includes(lowered));
    if (partial.length === 1) return { iso: partial[0].iso, status: PHONE_STATUSES.VALID, matches: partial };
    if (partial.length > 1) return { iso: null, status: PHONE_STATUSES.AMBIGUOUS, matches: partial.slice(0, 8) };

    return { iso: null, status: PHONE_STATUSES.INVALID, matches: [] };
}

function preprocess(raw) {
    let text = String(raw || "").trim();
    if (!text) return "";
    const compact = text.replace(/[^\d+]/g, "");
    if (/^00\d/.test(compact)) return `+${compact.slice(2)}`;
    if (/^011\d/.test(compact)) return `+${compact.slice(3)}`;
    return text;
}

function emptyResult(input) {
    return {
        input: input ?? "",
        e164: null,
        country: null,
        countryName: null,
        callingCode: null,
        nationalNumber: null,
        valid: false,
        possible: false,
        status: PHONE_STATUSES.EMPTY,
        issues: [],
        selectedCountry: null,
    };
}

function buildResult(partial) {
    const country = partial.country || null;
    return {
        input: partial.input ?? "",
        e164: partial.e164 || null,
        country,
        countryName: countryName(country),
        callingCode: partial.callingCode ? String(partial.callingCode) : null,
        nationalNumber: partial.nationalNumber || null,
        valid: Boolean(partial.valid),
        possible: Boolean(partial.possible),
        status: partial.status,
        issues: partial.issues || [],
        selectedCountry: partial.selectedCountry || null,
        matches: partial.matches || undefined,
    };
}

export function parsePhoneInput(raw, options = {}) {
    const original = raw == null ? "" : String(raw);
    if (!String(original).trim()) return emptyResult(original);

    const explicit = resolveCountry(options.explicitCountry || options.country || "");
    const fallback = resolveCountry(options.defaultCountry || "");

    if (explicit.status === PHONE_STATUSES.AMBIGUOUS) {
        return buildResult({
            input: original,
            status: PHONE_STATUSES.AMBIGUOUS,
            selectedCountry: options.explicitCountry || options.country,
            matches: explicit.matches,
            issues: [`Country "${options.explicitCountry || options.country}" matches more than one region. Use an ISO country code.`],
        });
    }
    if (fallback.status === PHONE_STATUSES.AMBIGUOUS && !explicit.iso) {
        return buildResult({
            input: original,
            status: PHONE_STATUSES.AMBIGUOUS,
            matches: fallback.matches,
            issues: [`Default country "${options.defaultCountry}" matches more than one region. Use an ISO country code.`],
        });
    }
    if ((options.explicitCountry || options.country) && explicit.status === PHONE_STATUSES.INVALID) {
        return buildResult({
            input: original,
            status: PHONE_STATUSES.INVALID,
            issues: [`Unknown country "${options.explicitCountry || options.country}".`],
        });
    }

    const prepared = preprocess(original);
    const compact = prepared.replace(/[^\d+]/g, "");
    const hasPlus = compact.startsWith("+");
    const defaultIso = explicit.iso || fallback.iso || undefined;

    if (!hasPlus && !defaultIso) {
        return buildResult({
            input: original,
            status: PHONE_STATUSES.MISSING_COUNTRY,
            issues: ["Phone number has no international prefix. Select a country or enter a number starting with +."],
        });
    }

    const parsed = parsePhoneNumberFromString(compact, hasPlus ? undefined : defaultIso);
    if (!parsed || !parsed.number) {
        return buildResult({
            input: original,
            country: defaultIso || null,
            selectedCountry: explicit.iso,
            callingCode: defaultIso ? getCountryCallingCode(defaultIso) : null,
            status: PHONE_STATUSES.INVALID,
            issues: ["Phone number could not be parsed for the selected country numbering plan."],
        });
    }

    const detectedIso = parsed.country || null;
    let selectedCallingCode = null;
    try {
        selectedCallingCode = explicit.iso ? String(getCountryCallingCode(explicit.iso)) : null;
    } catch {
        selectedCallingCode = null;
    }
    const parsedCallingCode = parsed.countryCallingCode ? String(parsed.countryCallingCode) : null;
    if (hasPlus && selectedCallingCode && parsedCallingCode && selectedCallingCode !== parsedCallingCode && !options.confirmConflict) {
        return buildResult({
            input: original,
            e164: parsed.number,
            country: detectedIso,
            callingCode: parsed.countryCallingCode,
            nationalNumber: parsed.nationalNumber,
            valid: parsed.isValid(),
            possible: parsed.isPossible(),
            selectedCountry: explicit.iso,
            status: PHONE_STATUSES.CONFLICT,
            issues: [
                `Number prefix is +${parsedCallingCode}${detectedIso ? ` (${countryName(detectedIso)})` : ""} but ${countryName(explicit.iso)} is selected. Confirm to keep the international prefix.`,
            ],
        });
    }

    const valid = parsed.isValid();
    const possible = parsed.isPossible();
    const status = valid ? PHONE_STATUSES.VALID : possible ? PHONE_STATUSES.POSSIBLE : PHONE_STATUSES.INVALID;
    const issues = [];
    if (status === PHONE_STATUSES.INVALID) {
        issues.push("Phone number is not valid for the detected country numbering plan.");
    } else if (status === PHONE_STATUSES.POSSIBLE) {
        issues.push("Number matches the country length but is not a confirmed numbering-plan assignment. Format was validated only.");
    }

    return buildResult({
        input: original,
        e164: parsed.number,
        country: detectedIso || defaultIso || null,
        callingCode: parsed.countryCallingCode,
        nationalNumber: parsed.nationalNumber,
        valid,
        possible,
        selectedCountry: explicit.iso,
        status,
        issues,
    });
}

export function isAcceptablePhone(parsed) {
    return Boolean(parsed && ACCEPTABLE.has(parsed.status) && parsed.e164);
}

export function assertPhoneOrEmpty(raw, options = {}) {
    const parsed = parsePhoneInput(raw, options);
    if (parsed.status === PHONE_STATUSES.EMPTY) return parsed;
    if (isAcceptablePhone(parsed)) return parsed;
    const error = new Error(parsed.issues[0] || `Invalid phone: ${raw}`);
    error.field = "phone";
    error.code = `PHONE_${parsed.status}`;
    error.details = parsed;
    error.statusCode = 400;
    throw error;
}

export function phoneLookupKeys(raw, options = {}) {
    const keys = new Set();
    const cleaned = String(raw || "").replace(/[^\d+]/g, "").trim();
    if (cleaned) keys.add(cleaned);
    const digits = cleaned.replace(/\D/g, "");
    if (digits) keys.add(digits);
    if (/^0\d{8,}$/.test(digits)) keys.add(digits.replace(/^0+/, ""));
    const parsed = parsePhoneInput(raw, { ...options, confirmConflict: true });
    if (parsed.e164) {
        keys.add(parsed.e164);
        keys.add(parsed.e164.replace(/^\+/, ""));
    }
    if (parsed.nationalNumber) keys.add(String(parsed.nationalNumber));
    return [...keys].filter(Boolean);
}

export function phoneDigitKeys(raw, options = {}) {
    return [...new Set(
        phoneLookupKeys(raw, options)
            .map((key) => String(key).replace(/\D/g, ""))
            .filter((key) => key.length >= 8)
    )];
}

export function phoneFieldsFromParsed(parsed) {
    if (!parsed || parsed.status === PHONE_STATUSES.EMPTY) {
        return {
            phone: null,
            phone_e164: null,
            phone_original: null,
            phone_country: null,
            phone_calling_code: null,
            phone_validation: PHONE_STATUSES.EMPTY,
        };
    }
    return {
        phone: parsed.e164 || null,
        phone_e164: parsed.e164 || null,
        phone_original: parsed.input || null,
        phone_country: parsed.country || null,
        phone_calling_code: parsed.callingCode || null,
        phone_validation: parsed.status,
    };
}

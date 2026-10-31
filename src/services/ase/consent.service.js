export const CONSENT_STATUSES = Object.freeze({
    GRANTED: "GRANTED",
    DENIED: "DENIED",
    UNKNOWN: "UNKNOWN",
});

export const CONSENT_SOURCES = Object.freeze({
    IMPORT: "import",
    REPLY: "reply",
    FORM: "form",
    API: "api",
});

const STATUS_SET = new Set(Object.values(CONSENT_STATUSES));

const SOURCE_ALIASES = {
    import: CONSENT_SOURCES.IMPORT,
    csv: CONSENT_SOURCES.IMPORT,
    csv_import: CONSENT_SOURCES.IMPORT,
    ingestion: CONSENT_SOURCES.IMPORT,
    reply: CONSENT_SOURCES.REPLY,
    imap: CONSENT_SOURCES.REPLY,
    unsubscribe: CONSENT_SOURCES.REPLY,
    form: CONSENT_SOURCES.FORM,
    ui: CONSENT_SOURCES.FORM,
    api: CONSENT_SOURCES.API,
};

export function normalizeConsentStatus(value) {
    const next = String(value || "").toUpperCase();
    if (next === "TRUE" || next === "YES" || next === "OPT_IN" || next === "OPTIN") {
        return CONSENT_STATUSES.GRANTED;
    }
    if (next === "FALSE" || next === "NO" || next === "OPT_OUT" || next === "OPTOUT") {
        return CONSENT_STATUSES.DENIED;
    }
    return STATUS_SET.has(next) ? next : CONSENT_STATUSES.UNKNOWN;
}

export function normalizeConsentSource(value) {
    const key = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    return SOURCE_ALIASES[key] || CONSENT_SOURCES.API;
}

export function buildConsentRecord({ status, source, actorUserId = null, timestamp = null } = {}) {
    return {
        status: normalizeConsentStatus(status),
        source: normalizeConsentSource(source),
        timestamp: timestamp || new Date().toISOString(),
        ...(actorUserId ? { actor_user_id: Number(actorUserId) } : {}),
    };
}

export function consentFromIntake(explicit, flag, source) {
    if (explicit && typeof explicit === "object" && explicit.status) {
        return buildConsentRecord({
            status: explicit.status,
            source: explicit.source || source,
            timestamp: explicit.timestamp,
            actorUserId: explicit.actor_user_id || explicit.actorUserId,
        });
    }
    if (flag === true) return buildConsentRecord({ status: CONSENT_STATUSES.GRANTED, source });
    // Unchecked UI checkboxes send `false`. That means consent was not collected, not an opt-out.
    if (flag === false || flag === 0 || flag === "0") {
        return buildConsentRecord({ status: CONSENT_STATUSES.UNKNOWN, source });
    }
    if (typeof flag === "string" && flag.trim()) {
        return buildConsentRecord({ status: flag, source });
    }
    return buildConsentRecord({ status: CONSENT_STATUSES.UNKNOWN, source });
}

const IMPLICIT_GRANT_SOURCES = new Set(["MANUAL", "CSV", "CSV_IMPORT", "API", "CRM_HUBSPOT"]);

export function applyImplicitChannelConsent(consent, { hasChannel = false, source = "", flag } = {}) {
    if (!hasChannel || !consent) return consent;
    if (consent.status === CONSENT_STATUSES.GRANTED || consent.status === CONSENT_STATUSES.DENIED) {
        return consent;
    }
    if (flag === false || flag === 0 || flag === "0") return consent;
    const src = String(source || "").toUpperCase();
    if (!IMPLICIT_GRANT_SOURCES.has(src)) return consent;
    return buildConsentRecord({
        status: CONSENT_STATUSES.GRANTED,
        source: source || consent.source,
        timestamp: consent.timestamp,
        actorUserId: consent.actor_user_id,
    });
}

export function isConsentGranted(consent) {
    if (!consent) return false;
    const status = typeof consent === "string" ? consent : consent.status;
    return normalizeConsentStatus(status) === CONSENT_STATUSES.GRANTED;
}

export function consentForAction(lead, action) {
    const act = String(action || "").toUpperCase();
    if (act === "EMAIL") return lead?.email_consent || null;
    if (act === "CALL") return lead?.voice_consent || null;
    if (act === "WHATSAPP") return lead?.whatsapp_consent || null;
    return null;
}

export function consentBlockReason(lead, action) {
    const act = String(action || "").toUpperCase();
    const consent = consentForAction(lead, action);
    if (isConsentGranted(consent)) return null;
    const status = normalizeConsentStatus(consent?.status);
    if (act === "EMAIL") {
        return status === CONSENT_STATUSES.DENIED
            ? "Email consent has been denied"
            : "Email consent has not been granted";
    }
    if (act === "CALL") {
        return status === CONSENT_STATUSES.DENIED
            ? "Voice consent has been denied"
            : "Voice consent has not been granted";
    }
    return "Channel consent has not been granted";
}

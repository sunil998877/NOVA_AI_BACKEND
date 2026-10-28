import { ASE_STATES } from "./leadStateMachine.js";
import {
    AFTER_NO_RESPONSE,
    DEFAULT_QUIET_DAYS,
    HEALTH,
    HOT_STATUSES,
    ILLEGAL_STATUS,
    LEGAL_NEXT_ACTIONS,
    LIFECYCLE_REASONS,
    MAX_CALLS,
    MAX_EMAILS,
    TERMINAL_STATES,
} from "./lifecycle.constants.js";

const LEGAL_ACTION_SET = new Set(LEGAL_NEXT_ACTIONS);
const TERMINAL_SET = new Set(TERMINAL_STATES);
const HOT_SET = new Set(HOT_STATUSES);
const AFTER_SET = new Set(Object.values(AFTER_NO_RESPONSE));
const HEALTH_SET = new Set(Object.values(HEALTH));

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function asUpper(value) {
    return String(value || "").trim().toUpperCase();
}

export function parseAttemptCounters(lead) {
    const raw = typeof lead?.attempt_counters === "string"
        ? (() => {
            try { return JSON.parse(lead.attempt_counters || "{}"); } catch { return {}; }
        })()
        : (lead?.attempt_counters || {});
    const email = Math.max(0, Number(raw.email || 0) || 0);
    const voice = Math.max(0, Number(raw.voice || 0) || 0);
    return {
        email,
        voice,
        total: Math.max(0, Number(raw.total || email + voice) || 0),
    };
}

export function normalizeAfterPolicy(value, fallback = AFTER_NO_RESPONSE.CLOSED_LOST) {
    const next = asUpper(value).replace(/[\s-]+/g, "_");
    if (next === "RE_ENGAGE" || next === "REENGAGE" || next === "POOL") {
        return AFTER_NO_RESPONSE.RE_ENGAGEMENT_POOL;
    }
    if (AFTER_SET.has(next)) return next;
    return fallback;
}

export function readLifecycleConfig(settings = {}, envCaps = {}) {
    const raw = settings?.lifecycle && typeof settings.lifecycle === "object" ? settings.lifecycle : {};
    return {
        maxEmails: positiveInt(raw.maxEmails ?? raw.max_emails, envCaps.maxEmails || MAX_EMAILS),
        maxCalls: positiveInt(raw.maxCalls ?? raw.max_calls, envCaps.maxCalls || MAX_CALLS),
        quietDays: positiveInt(raw.quietDays ?? raw.quiet_days, envCaps.quietDays || DEFAULT_QUIET_DAYS),
        afterNoResponse: normalizeAfterPolicy(raw.afterNoResponse ?? raw.after_no_response, AFTER_NO_RESPONSE.CLOSED_LOST),
        afterQuietDays: normalizeAfterPolicy(
            raw.afterQuietDays ?? raw.afterQuiet ?? raw.after_quiet_days,
            AFTER_NO_RESPONSE.CLOSED_LOST
        ),
    };
}

export function isTerminalStatus(status) {
    return TERMINAL_SET.has(asUpper(status));
}

export function isIllegalStatus(status) {
    return asUpper(status) === ILLEGAL_STATUS;
}

export function isOutreachStopped(lead) {
    if (!lead) return true;
    if (Number(lead.do_not_contact) === 1 || lead.do_not_contact === true) return true;
    return isTerminalStatus(lead.status);
}

export function sanitizeStatus(status) {
    const current = asUpper(status);
    if (!current) return ASE_STATES.NEW;
    if (isIllegalStatus(current)) return ASE_STATES.CONTACTED;
    if (Object.values(ASE_STATES).includes(current)) return current;
    return ASE_STATES.CONTACTED;
}

export function sanitizeNextAction(action) {
    if (action == null || action === "") return null;
    const next = asUpper(action);
    if (next === ILLEGAL_STATUS) return "WAIT";
    if (LEGAL_ACTION_SET.has(next)) return next;
    return "WAIT";
}

export function evaluateCapsExhaust(lead, config = {}) {
    const maxEmails = positiveInt(config.maxEmails, MAX_EMAILS);
    const maxCalls = positiveInt(config.maxCalls, MAX_CALLS);
    const counters = parseAttemptCounters(lead);
    const emailCapped = counters.email >= maxEmails;
    const voiceCapped = counters.voice >= maxCalls;
    return {
        exhausted: emailCapped && voiceCapped,
        emailCapped,
        voiceCapped,
        counters,
        maxEmails,
        maxCalls,
        reason: emailCapped && voiceCapped ? LIFECYCLE_REASONS.CAPS_EXHAUSTED : null,
    };
}

export function quietAnchorDate(lead) {
    const last = lead?.last_contacted_at || lead?.lastContactedAt;
    if (last) {
        const parsed = new Date(last);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    const created = lead?.created_at || lead?.createdAt;
    if (created) {
        const parsed = new Date(created);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return null;
}

export function evaluateQuietClose(lead, {
    now = new Date(),
    quietDays = DEFAULT_QUIET_DAYS,
    hasOpenCallback = false,
    hasOverdueCallback = false,
} = {}) {
    if (isOutreachStopped(lead)) {
        return { quiet: false, daysElapsed: 0, reason: null };
    }
    if (hasOpenCallback || hasOverdueCallback) {
        return { quiet: false, daysElapsed: 0, reason: null };
    }
    if (HOT_SET.has(asUpper(lead?.status)) || asUpper(lead?.next_action) === "REP_CALLBACK") {
        return { quiet: false, daysElapsed: 0, reason: null };
    }
    const days = positiveInt(quietDays, DEFAULT_QUIET_DAYS);
    const anchor = quietAnchorDate(lead);
    if (!anchor) return { quiet: false, daysElapsed: 0, reason: null };
    const daysElapsed = (new Date(now).getTime() - anchor.getTime()) / 86400000;
    if (daysElapsed >= days) {
        return { quiet: true, daysElapsed, reason: LIFECYCLE_REASONS.QUIET_DAYS };
    }
    return { quiet: false, daysElapsed, reason: null };
}

export function computeHealth(lead, {
    overdueHotCallback = false,
    openCallback = false,
    now = new Date(),
    quietDays = DEFAULT_QUIET_DAYS,
} = {}) {
    if (overdueHotCallback || asUpper(lead?.callback?.sla_status) === "BREACHED" || asUpper(lead?.callback?.status) === "OVERDUE") {
        return HEALTH.RED;
    }
    if (isOutreachStopped(lead)) {
        return asUpper(lead?.status) === ASE_STATES.CLOSED_WON ? HEALTH.GREEN : HEALTH.AMBER;
    }
    if (openCallback || HOT_SET.has(asUpper(lead?.status)) || asUpper(lead?.next_action) === "REP_CALLBACK") {
        return HEALTH.AMBER;
    }
    const counters = parseAttemptCounters(lead);
    if (counters.email >= MAX_EMAILS - 1 || counters.voice >= MAX_CALLS - 1) {
        return HEALTH.AMBER;
    }
    const quiet = evaluateQuietClose(lead, { now, quietDays, hasOpenCallback: openCallback });
    if (quiet.quiet || quiet.daysElapsed >= quietDays / 2) {
        return HEALTH.AMBER;
    }
    return HEALTH.GREEN;
}

export function normalizeHealth(value, fallback = HEALTH.GREEN) {
    const next = asUpper(value);
    return HEALTH_SET.has(next) ? next : fallback;
}

export function engineMayContact(lead, action = null) {
    if (isOutreachStopped(lead)) {
        const reason = Number(lead?.do_not_contact) === 1 || lead?.do_not_contact === true
            ? LIFECYCLE_REASONS.DNC
            : LIFECYCLE_REASONS.TERMINAL;
        return { allowed: false, reason };
    }
    const next = sanitizeNextAction(action || lead?.next_action);
    if (next && next !== "EMAIL" && next !== "CALL") {
        return { allowed: false, reason: LIFECYCLE_REASONS.NO_DISPATCHABLE_ACTION, action: next };
    }
    if (HOT_SET.has(asUpper(lead?.status)) || asUpper(lead?.next_action) === "REP_CALLBACK") {
        return { allowed: false, reason: LIFECYCLE_REASONS.NO_DISPATCHABLE_ACTION, action: next };
    }
    if (isIllegalStatus(lead?.status)) {
        return { allowed: false, reason: LIFECYCLE_REASONS.ILLEGAL_ATTEMPTED };
    }
    return { allowed: true, reason: null, action: next };
}

export function schedulerWouldDispatch(lead, action, extras = {}) {
    const contact = engineMayContact(lead, action);
    if (!contact.allowed) return false;
    const config = extras.config || readLifecycleConfig(extras.settings, extras.envCaps);
    const caps = evaluateCapsExhaust(lead, config);
    if (caps.exhausted) return false;
    if (asUpper(action) === "EMAIL" && caps.emailCapped) return false;
    if (asUpper(action) === "CALL" && caps.voiceCapped) return false;
    if (!extras.autonomous) return true;
    const quiet = evaluateQuietClose(lead, {
        now: extras.now,
        quietDays: config.quietDays,
        hasOpenCallback: Boolean(extras.hasOpenCallback),
        hasOverdueCallback: Boolean(extras.hasOverdueCallback),
    });
    return !quiet.quiet;
}

import {
    ANSWERED_RESULTS,
    APPROVAL_MODES,
    CADENCE_ACTIONS,
    CALL_RESULT,
    CLOSE_OUTCOMES,
    DECIDED_BY,
    DEFAULT_CADENCE_SETTINGS,
    ELIGIBILITY,
    ENROLLMENT_STATUS,
    HOT_LEAD_STATUSES,
    SETTINGS_LIMITS,
    STEP_PURPOSE,
    VOICEMAIL_ACTIONS,
} from "./cadence.constants.js";
import { addDaysToDate, addMinutes, alignToWindow, isInsideWindow, isValidTimezone } from "./cadenceTime.js";

const TERMINAL_LEAD_STATUSES = new Set(["CLOSED_WON", "CLOSED_LOST", "CLOSED_UNQUALIFIED", "SUPPRESSED_DNC"]);
const PERSONAL_EMAIL_DOMAINS = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "live.com", "aol.com", "proton.me", "protonmail.com", "rediffmail.com"]);
const ACCEPTABLE_PHONE = new Set(["VALID", "POSSIBLE"]);
const INVALID_NUMBER_CAUSE = /UNALLOCATED|INVALID|NUMBER_CHANGED|NO_ROUTE|UNKNOWN_DESTINATION|NOT_FOUND|BAD_DESTINATION/i;
const FALLBACK_TIMEZONE = "Asia/Kolkata";

function clampInt(value, [min, max], fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeWindow(raw, fallback, errors, label) {
    const source = raw && typeof raw === "object" ? raw : {};
    const startHour = clampInt(source.startHour, [0, 23], fallback.startHour);
    const endHour = clampInt(source.endHour, [1, 24], fallback.endHour);
    const days = Array.isArray(source.days)
        ? [...new Set(source.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
        : [...fallback.days];
    if (endHour <= startHour) errors.push(`${label}: endHour must be after startHour`);
    if (!days.length) errors.push(`${label}: at least one day is required`);
    return { startHour, endHour, days: days.length ? days : [...fallback.days] };
}

function normalizeFollowUpSteps(raw, errors) {
    if (!Array.isArray(raw)) return DEFAULT_CADENCE_SETTINGS.followUpSteps.map((step) => ({ ...step }));
    const allowed = new Set(Object.values(CADENCE_ACTIONS));
    const seen = new Set();
    const steps = [];
    for (const item of raw.slice(0, SETTINGS_LIMITS.followUpSteps[1])) {
        const action = String(item?.action || "").toUpperCase();
        if (!allowed.has(action)) {
            errors.push(`followUpSteps: unsupported action ${item?.action}`);
            continue;
        }
        const day = clampInt(item.day, SETTINGS_LIMITS.followUpDay, null);
        if (day == null) {
            errors.push("followUpSteps: day is required");
            continue;
        }
        const key = String(item.key || `day${day}_${action.toLowerCase()}`).replace(/[^a-z0-9_]/gi, "_").slice(0, 48);
        if (seen.has(key)) {
            errors.push(`followUpSteps: duplicate key ${key}`);
            continue;
        }
        seen.add(key);
        steps.push({
            key,
            day,
            action,
            purpose: String(item.purpose || defaultPurpose(action)).toUpperCase(),
        });
    }
    return steps.sort((a, b) => a.day - b.day);
}

function defaultPurpose(action) {
    if (action === CADENCE_ACTIONS.CALL) return STEP_PURPOSE.FOLLOW_UP_CALL;
    if (action === CADENCE_ACTIONS.EMAIL) return STEP_PURPOSE.VALUE_EMAIL;
    if (action === CADENCE_ACTIONS.HUMAN_REVIEW) return STEP_PURPOSE.REVIEW;
    return STEP_PURPOSE.CLOSE;
}

export function normalizeCadenceSettings(raw = {}) {
    const input = raw && typeof raw === "object" ? raw : {};
    const d = DEFAULT_CADENCE_SETTINGS;
    const L = SETTINGS_LIMITS;
    const errors = [];

    const firstAction = String(input.firstAction || d.firstAction).toUpperCase();
    if (![CADENCE_ACTIONS.CALL, CADENCE_ACTIONS.EMAIL].includes(firstAction)) errors.push("firstAction must be CALL or EMAIL");

    const voicemailAction = String(input.voicemailAction || d.voicemailAction).toUpperCase();
    if (!VOICEMAIL_ACTIONS.includes(voicemailAction)) errors.push("voicemailAction must be EMAIL, RETRY or HUMAN_REVIEW");

    const emailApprovalMode = String(input.emailApprovalMode || d.emailApprovalMode).toUpperCase();
    if (!APPROVAL_MODES.includes(emailApprovalMode)) errors.push("emailApprovalMode must be MANUAL or AUTO");

    const closeOutcome = String(input.closeOutcome || d.closeOutcome).toUpperCase();
    if (!CLOSE_OUTCOMES.includes(closeOutcome)) errors.push("closeOutcome must be NURTURE or CLOSED_LOST");

    const timezone = input.timezone ? String(input.timezone) : null;
    if (timezone && !isValidTimezone(timezone)) errors.push(`timezone ${timezone} is not a valid IANA timezone`);

    const settings = {
        firstAction: [CADENCE_ACTIONS.CALL, CADENCE_ACTIONS.EMAIL].includes(firstAction) ? firstAction : d.firstAction,
        maxInitialCallAttempts: clampInt(input.maxInitialCallAttempts, L.maxInitialCallAttempts, d.maxInitialCallAttempts),
        retryEnabled: input.retryEnabled === undefined ? d.retryEnabled : Boolean(input.retryEnabled),
        retryIntervalMinutes: clampInt(input.retryIntervalMinutes, L.retryIntervalMinutes, d.retryIntervalMinutes),
        busyRetryEnabled: input.busyRetryEnabled === undefined ? d.busyRetryEnabled : Boolean(input.busyRetryEnabled),
        busyRetryIntervalMinutes: clampInt(input.busyRetryIntervalMinutes, L.busyRetryIntervalMinutes, d.busyRetryIntervalMinutes),
        voicemailAction: VOICEMAIL_ACTIONS.includes(voicemailAction) ? voicemailAction : d.voicemailAction,
        emailAfterRetryDelayMinutes: clampInt(input.emailAfterRetryDelayMinutes, L.emailAfterRetryDelayMinutes, d.emailAfterRetryDelayMinutes),
        emailApprovalMode: APPROVAL_MODES.includes(emailApprovalMode) ? emailApprovalMode : d.emailApprovalMode,
        allowEmailAfterFailedCall: Boolean(input.allowEmailAfterFailedCall ?? d.allowEmailAfterFailedCall),
        maxTotalCalls: clampInt(input.maxTotalCalls, L.maxTotalCalls, d.maxTotalCalls),
        maxTotalEmails: clampInt(input.maxTotalEmails, L.maxTotalEmails, d.maxTotalEmails),
        timezone: timezone && isValidTimezone(timezone) ? timezone : null,
        callingWindow: normalizeWindow(input.callingWindow, d.callingWindow, errors, "callingWindow"),
        emailWindow: normalizeWindow(input.emailWindow, d.emailWindow, errors, "emailWindow"),
        followUpSteps: normalizeFollowUpSteps(input.followUpSteps, errors),
        closeOutcome: CLOSE_OUTCOMES.includes(closeOutcome) ? closeOutcome : d.closeOutcome,
    };
    if (settings.maxTotalCalls < settings.maxInitialCallAttempts) {
        settings.maxTotalCalls = settings.maxInitialCallAttempts;
    }
    return { settings, errors };
}

function readJson(value, fallback) {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function consentStatus(consent) {
    const parsed = readJson(consent, null);
    const status = typeof parsed === "string" ? parsed : parsed?.status;
    return String(status || "UNKNOWN").toUpperCase();
}

export function resolveLeadTimezone(lead, settings) {
    const meta = readJson(lead?.metadata, {}) || {};
    const candidates = [settings?.timezone, meta.timezone, readJson(lead?.segment_attributes, {})?.timezone];
    for (const tz of candidates) {
        if (isValidTimezone(tz)) return tz;
    }
    return isValidTimezone(process.env.ASE_CALLING_TIMEZONE) ? process.env.ASE_CALLING_TIMEZONE : FALLBACK_TIMEZONE;
}

export function evaluateLeadEligibility(lead, context = {}) {
    const settings = context.settings || DEFAULT_CADENCE_SETTINGS;
    const reasons = [];
    const add = (code, severity, message, channel = null) => reasons.push({ code, severity, message, channel });

    if (!lead) {
        return { result: ELIGIBILITY.SUPPRESSED, reasons: [{ code: "LEAD_MISSING", severity: "block", message: "Lead not found" }], channels: { call: false, email: false } };
    }

    const status = String(lead.status || "NEW").toUpperCase();
    const voice = consentStatus(lead.voice_consent);
    const email = consentStatus(lead.email_consent);

    if (lead.do_not_contact) add("DNC", "block", "Lead is marked Do Not Contact");
    if (context.suppressed) add("SUPPRESSED", "block", context.suppressedReason || "Lead matches the suppression list");
    if (TERMINAL_LEAD_STATUSES.has(status)) add("TERMINAL_STATUS", "block", `Lead is in terminal status ${status}`);
    if (voice === "DENIED" && email === "DENIED") add("ALL_CONSENT_DENIED", "block", "Both voice and email consent are denied");

    const phoneStatus = String(lead.phone_validation || "").toUpperCase();
    const phoneE164 = lead.phone_e164 || (String(lead.phone || "").startsWith("+") ? lead.phone : null);
    let callAllowed = true;
    if (!lead.phone && !lead.phone_e164) {
        callAllowed = false;
        add("PHONE_MISSING", "review", "No phone number on record", "CALL");
    } else if (phoneStatus === "MISSING_COUNTRY" || !phoneE164) {
        callAllowed = false;
        add("PHONE_COUNTRY_MISSING", "review", "Phone number has no international country code", "CALL");
    } else if (phoneStatus && !ACCEPTABLE_PHONE.has(phoneStatus)) {
        callAllowed = false;
        add("PHONE_INVALID", "review", `Phone number validation is ${phoneStatus}`, "CALL");
    }
    if (voice !== "GRANTED") {
        callAllowed = false;
        add(voice === "DENIED" ? "VOICE_CONSENT_DENIED" : "VOICE_CONSENT_MISSING", "review", `Voice consent is ${voice}`, "CALL");
    }

    let emailAllowed = true;
    const emailAddress = String(lead.email || "").trim().toLowerCase();
    const domain = emailAddress.split("@")[1] || "";
    if (!emailAddress || !domain) {
        emailAllowed = false;
        add("EMAIL_MISSING", "review", "No email address on record", "EMAIL");
    } else if (PERSONAL_EMAIL_DOMAINS.has(domain)) {
        add("EMAIL_NOT_BUSINESS", "warning", `Email uses a personal domain (${domain})`, "EMAIL");
    }
    if (email !== "GRANTED") {
        emailAllowed = false;
        add(email === "DENIED" ? "EMAIL_CONSENT_DENIED" : "EMAIL_CONSENT_MISSING", "review", `Email consent is ${email}`, "EMAIL");
    }

    if (!String(lead.company || "").trim()) add("COMPANY_MISSING", "review", "Company name is missing; research and personalization are not possible");
    if (!String(lead.first_name || lead.name || "").trim()) add("CONTACT_NAME_MISSING", "review", "Contact name is missing");
    if (context.openEnrollment) add("ALREADY_ENROLLED", "review", "Lead already has an open cadence enrollment");
    if (HOT_LEAD_STATUSES.has(status)) add("HUMAN_OWNED", "review", `Lead is in ${status}; a human owns the next step`);

    const firstChannelAllowed = settings.firstAction === CADENCE_ACTIONS.EMAIL ? emailAllowed : callAllowed;
    let result = ELIGIBILITY.ELIGIBLE;
    if (reasons.some((r) => r.severity === "block")) result = ELIGIBILITY.SUPPRESSED;
    else if (!firstChannelAllowed || reasons.some((r) => r.severity === "review" && r.channel == null)) result = ELIGIBILITY.NEEDS_REVIEW;

    return {
        result,
        reasons,
        channels: {
            call: result !== ELIGIBILITY.SUPPRESSED && callAllowed,
            email: result !== ELIGIBILITY.SUPPRESSED && emailAllowed,
        },
        consent: { voice, email },
    };
}

export function classifyCallResult({ normalizedOutcome, isAnswered = false, disposition = null, hangupCause = null } = {}) {
    const outcome = String(normalizedOutcome || "").toUpperCase().replace(/^OUTCOME_/, "");
    const disp = String(disposition || "").toLowerCase();
    switch (outcome) {
        case "DNC":
            return CALL_RESULT.OPT_OUT;
        case "NOT_INTERESTED":
            return CALL_RESULT.NOT_INTERESTED;
        case "CALLBACK":
            return CALL_RESULT.CALLBACK_REQUESTED;
        case "INTERESTED":
            return /meeting|demo|book/.test(disp) ? CALL_RESULT.MEETING_REQUESTED : CALL_RESULT.INTERESTED;
        case "PRICING":
            return CALL_RESULT.NEEDS_INFORMATION;
        case "WRONG_PERSON":
            return CALL_RESULT.FOLLOW_UP_REQUIRED;
        case "VOICEMAIL":
            return CALL_RESULT.VOICEMAIL;
        case "BUSY":
        case "REJECTED":
            return CALL_RESULT.BUSY;
        case "NO_ANSWER":
        case "RING_TIMEOUT":
            return CALL_RESULT.NO_ANSWER;
        case "FAILED":
        case "CANCELED":
        case "CANCELLED":
            return INVALID_NUMBER_CAUSE.test(String(hangupCause || "")) ? CALL_RESULT.INVALID_NUMBER : CALL_RESULT.FAILED;
        default:
            return isAnswered ? CALL_RESULT.FOLLOW_UP_REQUIRED : CALL_RESULT.NO_ANSWER;
    }
}

export function isAnsweredResult(result) {
    return ANSWERED_RESULTS.has(result);
}

function parseCallAttempt(stepKey) {
    const match = /^call:(\d+)$/.exec(String(stepKey || ""));
    return match ? Number(match[1]) : null;
}

function enrollmentFlags(enrollment) {
    return readJson(enrollment?.flags, {}) || {};
}

function stepDue(base, action, settings, timezone) {
    const window = action === CADENCE_ACTIONS.CALL ? settings.callingWindow : settings.emailWindow;
    if (action === CADENCE_ACTIONS.HUMAN_REVIEW || action === CADENCE_ACTIONS.CLOSE) return new Date(base);
    return alignToWindow(base, window, timezone);
}

function channelOpen(action, { settings, enrollment, channels }) {
    const flags = enrollmentFlags(enrollment);
    if (action === CADENCE_ACTIONS.CALL) {
        return channels.call !== false
            && !flags.invalidPhone
            && Number(enrollment?.call_attempts || 0) < settings.maxTotalCalls;
    }
    if (action === CADENCE_ACTIONS.EMAIL) {
        return channels.email !== false
            && !flags.emailUndeliverable
            && Number(enrollment?.email_attempts || 0) < settings.maxTotalEmails;
    }
    return true;
}

export function planFirstStep({ settings, now = new Date(), timezone = FALLBACK_TIMEZONE, channels = {}, immediate = false }) {
    const action = settings.firstAction;
    if (action === CADENCE_ACTIONS.CALL && channels.call === false) return null;
    if (action === CADENCE_ACTIONS.EMAIL && channels.email === false) return null;
    const stepKey = action === CADENCE_ACTIONS.CALL ? "call:1" : "email:first";
    const window = action === CADENCE_ACTIONS.CALL ? settings.callingWindow : settings.emailWindow;
    const insideNow = isInsideWindow(now, window, timezone);
    return {
        stepKey,
        action,
        purpose: action === CADENCE_ACTIONS.CALL ? STEP_PURPOSE.FIRST_CALL : STEP_PURPOSE.VALUE_EMAIL,
        dueAt: immediate && insideNow ? new Date(now) : stepDue(now, action, settings, timezone),
        outsideWindow: !insideNow,
        decidedBy: immediate ? DECIDED_BY.USER : DECIDED_BY.POLICY,
        reason: immediate ? "User started the autonomous call" : "Cadence first touch",
    };
}

export function planNextFollowUp({ settings, enrollment, afterKey = null, now = new Date(), timezone = FALLBACK_TIMEZONE, channels = {} }) {
    const steps = settings.followUpSteps || [];
    const startIndex = afterKey ? steps.findIndex((s) => s.key === afterKey) + 1 : 0;
    const startedAt = enrollment?.started_at ? new Date(enrollment.started_at) : new Date(now);
    const skipped = [];
    for (let i = Math.max(0, startIndex); i < steps.length; i += 1) {
        const step = steps[i];
        if (!channelOpen(step.action, { settings, enrollment, channels })) {
            skipped.push({ key: step.key, reason: `${step.action} channel unavailable or limit reached` });
            continue;
        }
        const scheduled = addDaysToDate(startedAt, step.day);
        const base = scheduled.getTime() > now.getTime() ? scheduled : now;
        return {
            next: {
                stepKey: step.key,
                action: step.action,
                purpose: step.purpose,
                dueAt: stepDue(base, step.action, settings, timezone),
                decidedBy: DECIDED_BY.POLICY,
                reason: `Cadence day ${step.day} ${step.purpose.toLowerCase()} touch`,
            },
            skipped,
        };
    }
    return { next: null, skipped };
}

function completion(settings, reason) {
    return {
        status: ENROLLMENT_STATUS.COMPLETED,
        stage: settings.closeOutcome === "CLOSED_LOST" ? "CLOSED_LOST" : "NURTURE",
        reason,
    };
}

function afterUnsuccessfulInitial({ settings, enrollment, now, timezone, channels, attempt, intervalMinutes, retryAllowed, result }) {
    if (retryAllowed && attempt < settings.maxInitialCallAttempts && channelOpen(CADENCE_ACTIONS.CALL, { settings, enrollment, channels })) {
        return {
            stage: "RETRY_CALL",
            newSteps: [{
                stepKey: `call:${attempt + 1}`,
                action: CADENCE_ACTIONS.CALL,
                purpose: STEP_PURPOSE.RETRY_CALL,
                dueAt: stepDue(addMinutes(now, intervalMinutes), CADENCE_ACTIONS.CALL, settings, timezone),
                decidedBy: DECIDED_BY.POLICY,
                reason: `${result} on attempt ${attempt}; retry after ${intervalMinutes} minutes`,
            }],
        };
    }
    return missedCallEmailOrNext({ settings, enrollment, now, timezone, channels, result });
}

function missedCallEmailOrNext({ settings, enrollment, now, timezone, channels, result, afterKey = null }) {
    if (channelOpen(CADENCE_ACTIONS.EMAIL, { settings, enrollment, channels })) {
        return {
            stage: "MISSED_CALL_EMAIL",
            newSteps: [{
                stepKey: "email:missed_call",
                action: CADENCE_ACTIONS.EMAIL,
                purpose: STEP_PURPOSE.MISSED_CALL_EMAIL,
                dueAt: stepDue(addMinutes(now, settings.emailAfterRetryDelayMinutes), CADENCE_ACTIONS.EMAIL, settings, timezone),
                decidedBy: DECIDED_BY.POLICY,
                reason: `${result} after call attempts; personalized follow-up email`,
            }],
        };
    }
    const planned = planNextFollowUp({ settings, enrollment, afterKey, now, timezone, channels });
    if (!planned.next) return { ...completion(settings, "No permitted touches remain"), newSteps: [] };
    return { stage: "FOLLOW_UP", newSteps: [planned.next], skipped: planned.skipped };
}

function nextOrComplete({ settings, enrollment, afterKey, now, timezone, channels }) {
    const planned = planNextFollowUp({ settings, enrollment, afterKey, now, timezone, channels });
    if (!planned.next) return { ...completion(settings, "Cadence finished without engagement"), newSteps: [] };
    return { stage: "FOLLOW_UP", newSteps: [planned.next], skipped: planned.skipped };
}

export function decideAfterCall({ settings, step, enrollment, result, now = new Date(), timezone = FALLBACK_TIMEZONE, channels = {} }) {
    const attempt = parseCallAttempt(step?.step_key);
    const initial = attempt != null;
    const afterKey = initial ? null : step?.step_key;
    const base = { result, cancelOpen: false, flags: {}, newSteps: [] };

    switch (result) {
        case CALL_RESULT.INTERESTED:
        case CALL_RESULT.MEETING_REQUESTED:
            return { ...base, status: ENROLLMENT_STATUS.HANDOFF, stage: "HANDOFF", cancelOpen: true, reason: "Prospect is interested; human sales handoff" };
        case CALL_RESULT.CALLBACK_REQUESTED:
            return { ...base, status: ENROLLMENT_STATUS.CALLBACK, stage: "CALLBACK", cancelOpen: true, reason: "Prospect requested a callback; automated touches paused" };
        case CALL_RESULT.NOT_INTERESTED:
            return { ...base, status: ENROLLMENT_STATUS.STOPPED, stage: "NOT_INTERESTED", cancelOpen: true, reason: "Prospect is not interested" };
        case CALL_RESULT.OPT_OUT:
            return { ...base, status: ENROLLMENT_STATUS.STOPPED, stage: "OPTED_OUT", cancelOpen: true, flags: { optedOut: true }, reason: "Prospect opted out" };
        case CALL_RESULT.NEEDS_INFORMATION:
        case CALL_RESULT.FOLLOW_UP_REQUIRED:
            return {
                ...base,
                status: ENROLLMENT_STATUS.NEEDS_REVIEW,
                stage: "ANSWERED_REVIEW",
                cancelOpen: true,
                newSteps: [{
                    stepKey: `review:answered_${step?.id || step?.step_key}`,
                    action: CADENCE_ACTIONS.HUMAN_REVIEW,
                    purpose: STEP_PURPOSE.REVIEW,
                    dueAt: new Date(now),
                    decidedBy: DECIDED_BY.RULE,
                    reason: `Call answered (${result}); a human decides the next step`,
                }],
                reason: `Call answered with ${result}`,
            };
        case CALL_RESULT.INVALID_NUMBER:
        case CALL_RESULT.FAILED: {
            const flags = result === CALL_RESULT.INVALID_NUMBER ? { invalidPhone: true } : { lastCallFailed: true };
            const flagged = { ...enrollment, flags: { ...enrollmentFlags(enrollment), ...flags } };
            if (settings.allowEmailAfterFailedCall && initial) {
                const plan = missedCallEmailOrNext({ settings, enrollment: flagged, now, timezone, channels: { ...channels, call: false }, result });
                return { ...base, ...plan, status: plan.status || ENROLLMENT_STATUS.ACTIVE, flags, reason: `${result}; policy allows email after failed call` };
            }
            return {
                ...base,
                status: ENROLLMENT_STATUS.NEEDS_REVIEW,
                stage: result === CALL_RESULT.INVALID_NUMBER ? "FIX_PHONE" : "CALL_FAILED",
                flags,
                reason: result === CALL_RESULT.INVALID_NUMBER ? "Phone number is invalid; correct it before calling again" : "Call failed at the provider; review before retrying",
            };
        }
        case CALL_RESULT.VOICEMAIL: {
            if (!initial) return { ...base, status: ENROLLMENT_STATUS.ACTIVE, ...nextOrComplete({ settings, enrollment, afterKey, now, timezone, channels }), reason: "Voicemail on follow-up call" };
            if (settings.voicemailAction === "HUMAN_REVIEW") {
                return {
                    ...base,
                    status: ENROLLMENT_STATUS.NEEDS_REVIEW,
                    stage: "VOICEMAIL_REVIEW",
                    newSteps: [{
                        stepKey: `review:voicemail_${attempt}`,
                        action: CADENCE_ACTIONS.HUMAN_REVIEW,
                        purpose: STEP_PURPOSE.REVIEW,
                        dueAt: new Date(now),
                        decidedBy: DECIDED_BY.POLICY,
                        reason: "Voicemail policy requires human review",
                    }],
                    reason: "Voicemail reached; policy routes to human review",
                };
            }
            if (settings.voicemailAction === "RETRY") {
                const plan = afterUnsuccessfulInitial({ settings, enrollment, now, timezone, channels, attempt, intervalMinutes: settings.retryIntervalMinutes, retryAllowed: settings.retryEnabled, result });
                return { ...base, status: plan.status || ENROLLMENT_STATUS.ACTIVE, ...plan, reason: "Voicemail reached; policy retries" };
            }
            const plan = missedCallEmailOrNext({ settings, enrollment, now, timezone, channels, result });
            return { ...base, status: plan.status || ENROLLMENT_STATUS.ACTIVE, ...plan, reason: "Voicemail reached; policy sends email" };
        }
        case CALL_RESULT.BUSY:
        case CALL_RESULT.NO_ANSWER:
        default: {
            const label = result || CALL_RESULT.NO_ANSWER;
            if (!initial) {
                const plan = nextOrComplete({ settings, enrollment, afterKey, now, timezone, channels });
                return { ...base, status: plan.status || ENROLLMENT_STATUS.ACTIVE, ...plan, reason: `${label} on follow-up call` };
            }
            const busy = label === CALL_RESULT.BUSY;
            const plan = afterUnsuccessfulInitial({
                settings,
                enrollment,
                now,
                timezone,
                channels,
                attempt,
                intervalMinutes: busy ? settings.busyRetryIntervalMinutes : settings.retryIntervalMinutes,
                retryAllowed: busy ? settings.busyRetryEnabled : settings.retryEnabled,
                result: label,
            });
            return { ...base, status: plan.status || ENROLLMENT_STATUS.ACTIVE, ...plan, reason: `${label} on attempt ${attempt}` };
        }
    }
}

export function decideAfterEmail({ settings, step, enrollment, outcome, now = new Date(), timezone = FALLBACK_TIMEZONE, channels = {} }) {
    const afterKey = settings.followUpSteps.some((s) => s.key === step?.step_key) ? step.step_key : null;
    const flags = outcome === "BOUNCED" ? { emailUndeliverable: true } : {};
    const flagged = { ...enrollment, flags: { ...enrollmentFlags(enrollment), ...flags } };
    const plan = nextOrComplete({ settings, enrollment: flagged, afterKey, now, timezone, channels });
    return {
        status: plan.status || ENROLLMENT_STATUS.ACTIVE,
        stage: plan.stage,
        newSteps: plan.newSteps,
        skipped: plan.skipped || [],
        flags,
        cancelOpen: false,
        reason: outcome === "BOUNCED" ? "Email bounced; address marked undeliverable" : `Email ${String(outcome || "SENT").toLowerCase()}`,
    };
}

export function decideAfterReview({ settings, step, enrollment, now = new Date(), timezone = FALLBACK_TIMEZONE, channels = {} }) {
    const afterKey = settings.followUpSteps.some((s) => s.key === step?.step_key) ? step.step_key : null;
    const plan = nextOrComplete({ settings, enrollment, afterKey, now, timezone, channels });
    return { status: plan.status || ENROLLMENT_STATUS.ACTIVE, stage: plan.stage, newSteps: plan.newSteps, flags: {}, cancelOpen: false, reason: "Reviewer resumed the cadence" };
}

export function precheckStep({ step, enrollment, lead, settings, now = new Date(), timezone = FALLBACK_TIMEZONE, replySinceStep = false, openCallback = false }) {
    const action = String(step?.action || "").toUpperCase();
    const status = String(enrollment?.status || "");
    const reviewStep = action === CADENCE_ACTIONS.HUMAN_REVIEW && status === ENROLLMENT_STATUS.NEEDS_REVIEW;
    if (!reviewStep && (status === ENROLLMENT_STATUS.PAUSED || status === ENROLLMENT_STATUS.NEEDS_REVIEW)) {
        return { proceed: false, verdict: "DEFER", reason: `Enrollment is ${status}` };
    }
    if (!reviewStep && status !== ENROLLMENT_STATUS.ACTIVE) {
        return { proceed: false, verdict: "CANCEL", reason: `Enrollment is ${status || "missing"}` };
    }
    if (!lead) return { proceed: false, verdict: "STOP", reason: "Lead no longer exists" };
    const leadStatus = String(lead.status || "").toUpperCase();
    if (lead.do_not_contact || leadStatus === "SUPPRESSED_DNC") return { proceed: false, verdict: "STOP", reason: "Lead is Do Not Contact" };
    if (TERMINAL_LEAD_STATUSES.has(leadStatus)) return { proceed: false, verdict: "STOP", reason: `Lead is ${leadStatus}` };
    if (replySinceStep) return { proceed: false, verdict: "REPLIED", reason: "Prospect replied; sequence paused for reply handling" };
    if (openCallback || HOT_LEAD_STATUSES.has(leadStatus)) {
        return { proceed: false, verdict: "HANDOFF", reason: openCallback ? "Open callback exists; avoiding conflicting touch" : `Lead is ${leadStatus}` };
    }

    const flags = enrollmentFlags(enrollment);
    if (action === CADENCE_ACTIONS.CALL) {
        if (flags.invalidPhone) return { proceed: false, verdict: "SKIP", reason: "Phone flagged invalid" };
        if (Number(enrollment.call_attempts || 0) >= settings.maxTotalCalls) return { proceed: false, verdict: "SKIP", reason: "Call attempt limit reached" };
        if (!isInsideWindow(now, settings.callingWindow, timezone)) {
            return { proceed: false, verdict: "RESCHEDULE", reason: "Outside calling hours", dueAt: alignToWindow(now, settings.callingWindow, timezone) };
        }
    }
    if (action === CADENCE_ACTIONS.EMAIL) {
        if (flags.emailUndeliverable) return { proceed: false, verdict: "SKIP", reason: "Email address is undeliverable" };
        if (Number(enrollment.email_attempts || 0) >= settings.maxTotalEmails) return { proceed: false, verdict: "SKIP", reason: "Email limit reached" };
    }
    return { proceed: true };
}

export function mapProviderCallState(providerStatus) {
    const s = String(providerStatus || "").toLowerCase();
    if (["queued", "initiated", "request_queued"].includes(s)) return "CALLING";
    if (s === "ringing" || s === "early-media") return "RINGING";
    if (s === "in-progress" || s === "answered") return "IN_PROGRESS";
    if (s === "completed") return "COMPLETED";
    if (s === "busy" || s === "rejected") return "BUSY";
    if (s === "no-answer" || s === "timeout") return "NO_ANSWER";
    if (s === "canceled" || s === "cancelled") return "CANCELLED";
    if (s === "failed" || s === "request_failed") return "FAILED";
    return null;
}

export function callStateForResult(result) {
    if (result === CALL_RESULT.NO_ANSWER) return "NO_ANSWER";
    if (result === CALL_RESULT.BUSY) return "BUSY";
    if (result === CALL_RESULT.VOICEMAIL) return "VOICEMAIL";
    if (result === CALL_RESULT.FAILED || result === CALL_RESULT.INVALID_NUMBER) return "FAILED";
    return "COMPLETED";
}

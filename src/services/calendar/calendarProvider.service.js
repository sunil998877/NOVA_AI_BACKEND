import { JWT, OAuth2Client } from "google-auth-library";
import { env } from "../../config/env.js";

const GOOGLE_API = "https://www.googleapis.com/calendar/v3";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

export class CalendarError extends Error {
    constructor(message, code, { status = null, retryable = false } = {}) {
        super(message);
        this.name = "CalendarError";
        this.code = code;
        this.status = status;
        this.retryable = retryable;
    }
}

/**
 * Google event ids must be 5-1024 chars of base32hex (0-9, a-v). Deterministic per
 * meeting + revision so a retried create after a timeout returns 409 instead of a duplicate.
 */
export function deterministicEventId(orgId, meetingId, revision = 0) {
    return `nova${Number(orgId)}m${Number(meetingId)}r${Number(revision)}`.toLowerCase();
}

const notConfiguredProvider = Object.freeze({
    name: "none",
    configured: false,
    async checkAvailability() {
        throw new CalendarError("No calendar provider is configured (CALENDAR_PROVIDER)", "CALENDAR_NOT_CONFIGURED");
    },
    async createEvent() {
        throw new CalendarError("No calendar provider is configured (CALENDAR_PROVIDER)", "CALENDAR_NOT_CONFIGURED");
    },
    async updateEvent() {
        throw new CalendarError("No calendar provider is configured (CALENDAR_PROVIDER)", "CALENDAR_NOT_CONFIGURED");
    },
    async cancelEvent() {
        throw new CalendarError("No calendar provider is configured (CALENDAR_PROVIDER)", "CALENDAR_NOT_CONFIGURED");
    },
});

function parseServiceAccountKey(raw) {
    if (!raw) return null;
    const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    try {
        const parsed = JSON.parse(text);
        return parsed.client_email && parsed.private_key ? parsed : null;
    } catch {
        return null;
    }
}

function createGoogleAuth(config, subject = null) {
    const key = parseServiceAccountKey(config.serviceAccountKey);
    if (key) {
        return new JWT({
            email: key.client_email,
            key: key.private_key,
            scopes: [CALENDAR_SCOPE],
            subject: subject || undefined,
        });
    }
    if (config.clientId && config.clientSecret && config.refreshToken) {
        const client = new OAuth2Client(config.clientId, config.clientSecret);
        client.setCredentials({ refresh_token: config.refreshToken });
        return client;
    }
    return null;
}

export function createGoogleCalendarProvider(config = env.calendar, { fetchImpl = globalThis.fetch, auth = null } = {}) {
    if (!auth && !createGoogleAuth(config)) return { ...notConfiguredProvider, name: "google" };

    const authCache = new Map();
    const authFor = (calendarId) => {
        if (auth) return auth;
        const subject = config.impersonateRep && calendarId?.includes("@") ? calendarId : null;
        const key = subject || "_default";
        if (!authCache.has(key)) authCache.set(key, createGoogleAuth(config, subject));
        return authCache.get(key);
    };

    async function request(calendarId, method, path, body = null) {
        let token;
        try {
            ({ token } = await authFor(calendarId).getAccessToken());
        } catch (err) {
            throw new CalendarError(`Calendar authentication failed: ${err.message}`, "CALENDAR_AUTH_FAILED");
        }
        if (!token) throw new CalendarError("Calendar authentication returned no token", "CALENDAR_AUTH_FAILED");

        let response;
        try {
            response = await fetchImpl(`${GOOGLE_API}${path}`, {
                method,
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(15000),
            });
        } catch (err) {
            throw new CalendarError(`Calendar request failed: ${err.message}`, "CALENDAR_UNREACHABLE", { retryable: true });
        }
        const text = await response.text();
        const data = text ? JSON.parse(text) : null;
        return { status: response.status, ok: response.ok, data };
    }

    const sendUpdates = encodeURIComponent(config.sendUpdates || "all");
    const eventPath = (calendarId, eventId = "") =>
        `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;

    const failure = (res, code) =>
        new CalendarError(
            res.data?.error?.message || `Calendar API returned HTTP ${res.status}`,
            code,
            { status: res.status, retryable: res.status >= 500 || res.status === 429 }
        );

    const toResult = (event, created) => ({
        eventId: event.id,
        status: event.status,
        htmlLink: event.htmlLink || null,
        iCalUID: event.iCalUID || null,
        start: event.start?.dateTime || null,
        end: event.end?.dateTime || null,
        created,
    });

    return {
        name: "google",
        configured: true,

        async checkAvailability({ calendarId, start, end, timezone }) {
            const res = await request(calendarId, "POST", "/freeBusy", {
                timeMin: new Date(start).toISOString(),
                timeMax: new Date(end).toISOString(),
                timeZone: timezone || "UTC",
                items: [{ id: calendarId }],
            });
            if (!res.ok) throw failure(res, "AVAILABILITY_CHECK_FAILED");
            const cal = res.data?.calendars?.[calendarId];
            if (!cal || cal.errors?.length) {
                const reason = cal?.errors?.[0]?.reason || "calendar_not_found";
                throw new CalendarError(`Cannot read rep calendar availability (${reason})`, "AVAILABILITY_CHECK_FAILED");
            }
            const busy = Array.isArray(cal.busy) ? cal.busy : [];
            return { available: busy.length === 0, busy };
        },

        async createEvent({ calendarId, eventId, summary, description, start, end, timezone, attendees = [] }) {
            const body = {
                id: eventId,
                summary,
                description,
                start: { dateTime: new Date(start).toISOString(), timeZone: timezone },
                end: { dateTime: new Date(end).toISOString(), timeZone: timezone },
                attendees: attendees.filter(Boolean).map((email) => ({ email })),
                reminders: { useDefault: true },
            };
            const res = await request(calendarId, "POST", `${eventPath(calendarId)}?sendUpdates=${sendUpdates}`, body);
            if (res.ok) return toResult(res.data, true);
            if (res.status === 409) {
                const existing = await request(calendarId, "GET", eventPath(calendarId, eventId));
                if (existing.ok && existing.data?.status !== "cancelled") return toResult(existing.data, false);
                throw new CalendarError("Event id already used by a cancelled event", "EVENT_ID_CONFLICT", { status: 409 });
            }
            throw failure(res, "EVENT_CREATE_FAILED");
        },

        async updateEvent({ calendarId, eventId, start, end, timezone }) {
            const res = await request(calendarId, "PATCH", `${eventPath(calendarId, eventId)}?sendUpdates=${sendUpdates}`, {
                start: { dateTime: new Date(start).toISOString(), timeZone: timezone },
                end: { dateTime: new Date(end).toISOString(), timeZone: timezone },
            });
            if (!res.ok) throw failure(res, "EVENT_UPDATE_FAILED");
            return toResult(res.data, false);
        },

        async cancelEvent({ calendarId, eventId }) {
            const res = await request(calendarId, "DELETE", `${eventPath(calendarId, eventId)}?sendUpdates=${sendUpdates}`);
            if (res.ok || res.status === 410 || res.status === 404) return { cancelled: true, alreadyGone: !res.ok };
            throw failure(res, "EVENT_CANCEL_FAILED");
        },
    };
}

let overrideProvider = null;
let cachedProvider = null;

export function getCalendarProvider() {
    if (overrideProvider) return overrideProvider;
    if (!cachedProvider) {
        cachedProvider = env.calendar.provider === "google" ? createGoogleCalendarProvider() : notConfiguredProvider;
    }
    return cachedProvider;
}

/** Test seam: inject a fake provider; pass null to restore the configured one. */
export function setCalendarProviderForTests(provider) {
    overrideProvider = provider;
}

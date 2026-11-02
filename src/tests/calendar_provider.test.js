import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createGoogleCalendarProvider, deterministicEventId, getCalendarProvider } from "../services/calendar/calendarProvider.service.js";
import { parseMeetingStart } from "../services/ase/meetingBooking.service.js";
import { shouldApplyHandoffStatus, HANDOFF_STATUSES as H } from "../services/ase/handoffStatus.service.js";

const auth = { getAccessToken: async () => ({ token: "test-token" }) };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => (body ? JSON.stringify(body) : "") });

function fakeFetch(handlers) {
    const calls = [];
    const impl = async (url, init = {}) => {
        calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
        const handler = handlers.shift();
        if (!handler) throw new Error(`unexpected request ${init.method} ${url}`);
        return handler(url, init);
    };
    return { impl, calls };
}

describe("calendar provider", () => {
    test("no provider configured is reported as not configured", () => {
        assert.equal(getCalendarProvider().configured, false);
    });

    test("event ids are deterministic base32hex per meeting revision", () => {
        assert.equal(deterministicEventId(3, 41, 0), "nova3m41r0");
        assert.equal(deterministicEventId(3, 41, 0), deterministicEventId(3, 41, 0));
        assert.notEqual(deterministicEventId(3, 41, 1), deterministicEventId(3, 41, 0));
        assert.match(deterministicEventId(12, 999, 7), /^[0-9a-v]{5,1024}$/);
    });

    test("free/busy reports real rep availability", async () => {
        const { impl, calls } = fakeFetch([
            () => json(200, { calendars: { "rep@example.test": { busy: [{ start: "2026-11-05T09:30:00Z", end: "2026-11-05T10:00:00Z" }] } } }),
        ]);
        const provider = createGoogleCalendarProvider({ sendUpdates: "all" }, { fetchImpl: impl, auth });
        const result = await provider.checkAvailability({ calendarId: "rep@example.test", start: "2026-11-05T09:30:00Z", end: "2026-11-05T10:00:00Z", timezone: "UTC" });
        assert.equal(result.available, false);
        assert.equal(calls[0].body.items[0].id, "rep@example.test");
    });

    test("unreadable rep calendar is an error, never 'available'", async () => {
        const { impl } = fakeFetch([() => json(200, { calendars: { "rep@example.test": { errors: [{ reason: "notFound" }] } } })]);
        const provider = createGoogleCalendarProvider({}, { fetchImpl: impl, auth });
        await assert.rejects(
            provider.checkAvailability({ calendarId: "rep@example.test", start: new Date(), end: new Date() }),
            (err) => err.code === "AVAILABILITY_CHECK_FAILED"
        );
    });

    test("a retried create (409) returns the existing event instead of a duplicate", async () => {
        const existing = { id: "nova1m5r0", status: "confirmed", htmlLink: "https://calendar.example/e", start: { dateTime: "2026-11-05T09:30:00Z" } };
        const { impl, calls } = fakeFetch([() => json(409, { error: { message: "duplicate" } }), () => json(200, existing)]);
        const provider = createGoogleCalendarProvider({}, { fetchImpl: impl, auth });
        const event = await provider.createEvent({ calendarId: "rep@example.test", eventId: "nova1m5r0", summary: "x", start: "2026-11-05T09:30:00Z", end: "2026-11-05T10:00:00Z", timezone: "UTC" });
        assert.equal(event.eventId, "nova1m5r0");
        assert.equal(event.created, false);
        assert.equal(calls.filter((c) => c.method === "POST").length, 1);
        assert.equal(calls[0].body.id, "nova1m5r0");
    });

    test("provider errors surface as failures", async () => {
        const { impl } = fakeFetch([() => json(500, { error: { message: "backend error" } })]);
        const provider = createGoogleCalendarProvider({}, { fetchImpl: impl, auth });
        await assert.rejects(
            provider.createEvent({ calendarId: "c", eventId: "nova1m1r0", start: new Date(), end: new Date(), timezone: "UTC" }),
            (err) => err.code === "EVENT_CREATE_FAILED" && err.retryable === true
        );
    });

    test("cancel treats an already-deleted event as cancelled", async () => {
        const { impl } = fakeFetch([() => json(410, null)]);
        const provider = createGoogleCalendarProvider({}, { fetchImpl: impl, auth });
        assert.deepEqual(await provider.cancelEvent({ calendarId: "c", eventId: "nova1m1r0" }), { cancelled: true, alreadyGone: true });
    });
});

describe("meeting time and handoff status rules", () => {
    test("wall-clock time is resolved in the given timezone", () => {
        const start = parseMeetingStart("2030-01-15T15:00", "Asia/Kolkata");
        assert.equal(start.toISOString(), "2030-01-15T09:30:00.000Z");
        assert.equal(parseMeetingStart("2030-01-15T09:30:00Z", "UTC").toISOString(), "2030-01-15T09:30:00.000Z");
    });

    test("date, time and a valid timezone are required; past times are rejected", () => {
        assert.throws(() => parseMeetingStart("2030-01-15T15:00", ""), (err) => err.code === "INVALID_TIMEZONE");
        assert.throws(() => parseMeetingStart("2030-01-15T15:00", "Mars/Base"), (err) => err.code === "INVALID_TIMEZONE");
        assert.throws(() => parseMeetingStart("", "UTC"), (err) => err.code === "MISSING_DATE_TIME");
        assert.throws(() => parseMeetingStart("2020-01-01T10:00", "UTC"), (err) => err.code === "TIME_IN_PAST");
    });

    test("detection paths never downgrade a meeting; interest is not a meeting", () => {
        assert.equal(shouldApplyHandoffStatus(null, H.INTERESTED), true);
        assert.equal(shouldApplyHandoffStatus(H.INTERESTED, H.CALLBACK_PENDING), true);
        assert.equal(shouldApplyHandoffStatus(H.MEETING_BOOKED, H.INTERESTED), false);
        assert.equal(shouldApplyHandoffStatus(H.MEETING_REQUESTED, H.CALLBACK_PENDING), false);
        assert.equal(shouldApplyHandoffStatus(H.MEETING_CANCELLED, H.INTERESTED), true);
        assert.equal(shouldApplyHandoffStatus(H.MEETING_BOOKED, H.MEETING_CANCELLED, { authoritative: true }), true);
    });
});

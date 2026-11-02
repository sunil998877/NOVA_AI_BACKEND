import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { User } from "../../models/user.model.js";
import { SalesMeeting } from "../../models/sales-meeting.model.js";
import { MEETING_STATUSES } from "../../schema/sales-meeting.schema.js";
import { env } from "../../config/env.js";
import { getIo } from "../../socket/socketServer.js";
import { CalendarError, deterministicEventId, getCalendarProvider } from "../calendar/calendarProvider.service.js";
import { isValidTimezone, zonedToUtc } from "./cadence/cadenceTime.js";
import { HANDOFF_STATUSES, setHandoffStatus } from "./handoffStatus.service.js";
import { followUpEngine } from "../followup/followUpEngine.service.js";

const { MEETING_REQUESTED, MEETING_PENDING, MEETING_BOOKED, BOOKING_FAILED, MEETING_CANCELLED } = MEETING_STATUSES;
const PREFERENCE_EDITABLE = [MEETING_REQUESTED, MEETING_PENDING, BOOKING_FAILED];
const BOOKABLE = [MEETING_PENDING, BOOKING_FAILED];
const MIN_LEAD_TIME_MS = 5 * 60 * 1000;
// Event ids of withdrawn/cancelled events cannot be reused in Google Calendar.
const REVISION_BUMP_CODES = new Set(["EVENT_ID_CONFLICT", "EVENT_NOT_CONFIRMED"]);

export class MeetingError extends Error {
    constructor(message, code, httpStatus = 400, details = null) {
        super(message);
        this.name = "MeetingError";
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
    }
}

/**
 * Accepts an ISO instant ("2026-11-05T09:30:00Z", "...+05:30") or a wall-clock time
 * ("2026-11-05T15:00") interpreted in `timezone`. A timezone is always required so the
 * calendar event and the invite show the prospect's intended local time.
 */
export function parseMeetingStart(preferredStart, timezone, { now = Date.now() } = {}) {
    if (!timezone || !isValidTimezone(timezone)) {
        throw new MeetingError("A valid IANA timezone is required (e.g. Asia/Kolkata)", "INVALID_TIMEZONE", 422);
    }
    const raw = String(preferredStart || "").trim();
    if (!raw) throw new MeetingError("Meeting date and time are required", "MISSING_DATE_TIME", 422);

    let start;
    if (/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
        start = new Date(raw);
    } else {
        const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/);
        if (!match) throw new MeetingError("Use YYYY-MM-DDTHH:mm for the meeting time", "INVALID_DATE_TIME", 422);
        const [, y, mo, d, h, mi] = match.map(Number);
        start = zonedToUtc(timezone, y, mo, d, h, mi);
    }
    if (Number.isNaN(start.getTime())) throw new MeetingError("Invalid meeting date/time", "INVALID_DATE_TIME", 422);
    if (start.getTime() < now + MIN_LEAD_TIME_MS) {
        throw new MeetingError("Meeting time must be at least 5 minutes in the future", "TIME_IN_PAST", 422);
    }
    return start;
}

function normalizeDuration(value) {
    const minutes = Number(value || env.calendar.defaultDurationMinutes || 30);
    if (!Number.isInteger(minutes) || minutes < 10 || minutes > 240) {
        throw new MeetingError("Duration must be between 10 and 240 minutes", "INVALID_DURATION", 422);
    }
    return minutes;
}

async function recordEvent(meeting, eventType, payload = {}, idempotencyKey = undefined) {
    await LeadEvent.create({
        organization_id: meeting.organization_id,
        lead_id: meeting.lead_id,
        user_id: payload.actorUserId || null,
        channel: "CALENDAR",
        event_type: eventType,
        status: meeting.status,
        payload: {
            meetingId: meeting.id,
            status: meeting.status,
            start: meeting.start_at || meeting.preferred_start || null,
            timezone: meeting.timezone || null,
            calendarEventId: meeting.calendar_event_id || null,
            ...payload,
        },
        idempotency_key: idempotencyKey,
    }).catch((err) => console.warn(`[Meeting] ${eventType} event failed:`, err.message));
    getIo()?.to(`org:${meeting.organization_id}`).emit("meeting:updated", {
        meetingId: meeting.id,
        leadId: meeting.lead_id,
        status: meeting.status,
    });
}

async function loadMeeting(orgId, meetingId) {
    const meeting = await SalesMeeting.findById(orgId, meetingId);
    if (!meeting) throw new MeetingError("Meeting not found", "NOT_FOUND", 404);
    return meeting;
}

async function loadContactableLead(orgId, leadId) {
    const lead = await Lead.findById(Number(leadId), orgId);
    if (!lead) throw new MeetingError("Lead not found", "LEAD_NOT_FOUND", 404);
    if (lead.do_not_contact || lead.status === "SUPPRESSED_DNC") {
        throw new MeetingError("Lead has opted out; a meeting cannot be scheduled", "LEAD_NOT_CONTACTABLE", 409);
    }
    return lead;
}

async function resolveRepCalendar(orgId, meeting, lead) {
    const repUserId = meeting.rep_user_id || lead.assigned_rep_id || null;
    if (repUserId) {
        const rep = await User.findById(Number(repUserId));
        if (rep && Number(rep.organization_id) === Number(orgId) && rep.email) {
            return { repUserId: rep.id, calendarId: rep.email, repEmail: rep.email, repName: rep.name || null };
        }
    }
    if (env.calendar.defaultCalendarId) {
        return { repUserId: null, calendarId: env.calendar.defaultCalendarId, repEmail: null, repName: null };
    }
    throw new MeetingError(
        "No sales rep calendar for this meeting: assign a rep or set GOOGLE_CALENDAR_DEFAULT_ID",
        "NO_REP_CALENDAR",
        422
    );
}

export async function requestMeeting(orgId, leadId, options = {}) {
    const {
        source = "MANUAL",
        sourceRef = null,
        preferredText = null,
        preferredStart = null,
        timezone = null,
        durationMinutes = null,
        repUserId = null,
        actorUserId = null,
    } = options;
    const lead = await loadContactableLead(orgId, leadId);

    const hasPreferences = Boolean(preferredStart);
    const start = hasPreferences ? parseMeetingStart(preferredStart, timezone) : null;
    const duration = normalizeDuration(durationMinutes);
    const status = hasPreferences ? MEETING_PENDING : MEETING_REQUESTED;

    const { created, meeting } = await SalesMeeting.createOnce({
        organization_id: orgId,
        lead_id: lead.id,
        rep_user_id: repUserId || lead.assigned_rep_id || null,
        source,
        source_ref: sourceRef,
        status,
        title: `Meeting with ${lead.name || lead.company || lead.email || `lead ${lead.id}`}`,
        preferred_text: preferredText,
        preferred_start: start,
        timezone: hasPreferences ? timezone : null,
        duration_minutes: duration,
        created_by: actorUserId,
    });
    if (!meeting) throw new MeetingError("Could not create the meeting request", "CREATE_FAILED", 500);

    if (!created) {
        if (hasPreferences && PREFERENCE_EDITABLE.includes(meeting.status)) {
            return {
                created: false,
                meeting: await setMeetingPreferences(orgId, meeting.id, { preferredStart, timezone, durationMinutes, repUserId, actorUserId }),
            };
        }
        return { created: false, meeting };
    }

    await recordEvent(meeting, "MEETING_REQUESTED", { source, sourceRef, preferredText, actorUserId }, `meeting_${meeting.id}_requested`);
    if (status === MEETING_PENDING) {
        await recordEvent(meeting, "MEETING_PENDING", { actorUserId, durationMinutes: duration }, `meeting_${meeting.id}_pending_${start.getTime()}`);
    }
    await setHandoffStatus(lead, status === MEETING_PENDING ? HANDOFF_STATUSES.MEETING_PENDING : HANDOFF_STATUSES.MEETING_REQUESTED, {
        orgId,
        source,
        reason: "Prospect requested a meeting",
        meetingId: meeting.id,
        actorUserId,
        authoritative: true,
    });
    await followUpEngine.handleHumanHandoff(lead.id, orgId, "Prospect requested a meeting").catch(() => {});
    return { created: true, meeting };
}

/** Collect date/time/timezone for a requested meeting; the meeting becomes a pending booking task. */
export async function setMeetingPreferences(orgId, meetingId, options = {}) {
    const { preferredStart, timezone, durationMinutes, repUserId, preferredText, actorUserId = null } = options;
    const meeting = await loadMeeting(orgId, meetingId);
    if (meeting.status === MEETING_BOOKED) {
        throw new MeetingError("Meeting is already booked; use reschedule", "ALREADY_BOOKED", 409);
    }
    if (!PREFERENCE_EDITABLE.includes(meeting.status)) {
        throw new MeetingError(`Meeting is ${meeting.status}`, "INVALID_STATE", 409);
    }
    const start = parseMeetingStart(preferredStart, timezone);
    const duration = normalizeDuration(durationMinutes ?? meeting.duration_minutes);

    const updated = await SalesMeeting.transition(orgId, meeting.id, PREFERENCE_EDITABLE, MEETING_PENDING, {
        preferred_start: start,
        timezone,
        duration_minutes: duration,
        rep_user_id: repUserId ? Number(repUserId) : undefined,
        preferred_text: preferredText || undefined,
        last_error: null,
    });
    if (!updated) throw new MeetingError("Meeting changed while updating; reload and retry", "CONFLICT", 409);

    await recordEvent(updated, "MEETING_PENDING", { actorUserId, durationMinutes: duration }, `meeting_${updated.id}_pending_${start.getTime()}_${duration}`);
    await setHandoffStatus(updated.lead_id, HANDOFF_STATUSES.MEETING_PENDING, {
        orgId,
        source: "CALENDAR",
        reason: "Meeting time collected; awaiting calendar booking",
        meetingId: updated.id,
        actorUserId,
        authoritative: true,
    });
    return updated;
}

async function markBookingFailed(orgId, meeting, code, message, details = {}) {
    const failed = await SalesMeeting.transition(orgId, meeting.id, BOOKABLE, BOOKING_FAILED, {
        last_error: `${code}: ${message}`.slice(0, 1000),
        booking_claimed_at: null,
        booking_revision: REVISION_BUMP_CODES.has(code) ? Number(meeting.booking_revision || 0) + 1 : undefined,
    }) || await SalesMeeting.findById(orgId, meeting.id);
    await SalesMeeting.releaseClaim(orgId, meeting.id).catch(() => {});

    await recordEvent(failed, "MEETING_BOOKING_FAILED", { code, message, ...details });
    await setHandoffStatus(meeting.lead_id, HANDOFF_STATUSES.BOOKING_FAILED, {
        orgId,
        source: "CALENDAR",
        reason: `Calendar booking failed (${code})`,
        meetingId: meeting.id,
        authoritative: true,
    }).catch(() => {});
    return { booked: false, meeting: failed, failure: { code, message, ...details } };
}

/**
 * Books the meeting in the rep's calendar. MEETING_BOOKED is written only after the
 * provider returns a confirmed event id; every other outcome is BOOKING_FAILED.
 */
export async function bookMeeting(orgId, meetingId, { actorUserId = null, provider = null } = {}) {
    const meeting = await loadMeeting(orgId, meetingId);
    if (meeting.status === MEETING_BOOKED && meeting.calendar_event_id) {
        return { booked: true, alreadyBooked: true, meeting };
    }
    if (!BOOKABLE.includes(meeting.status)) {
        const hint = meeting.status === MEETING_REQUESTED ? "; collect date, time and timezone first" : "";
        throw new MeetingError(`Meeting is ${meeting.status}${hint}`, "NOT_BOOKABLE", 409);
    }
    if (!meeting.preferred_start || !meeting.timezone) {
        throw new MeetingError("Meeting date, time and timezone are required before booking", "MISSING_DATE_TIME", 422);
    }

    const lead = await loadContactableLead(orgId, meeting.lead_id);
    const rep = await resolveRepCalendar(orgId, meeting, lead);

    const claimed = await SalesMeeting.claimForBooking(orgId, meeting.id, BOOKABLE);
    if (!claimed) {
        const current = await SalesMeeting.findById(orgId, meeting.id);
        if (current?.status === MEETING_BOOKED && current.calendar_event_id) {
            return { booked: true, alreadyBooked: true, meeting: current };
        }
        throw new MeetingError("A booking attempt for this meeting is already in progress", "BOOKING_IN_PROGRESS", 409);
    }

    const calendar = provider || getCalendarProvider();
    if (!calendar?.configured) {
        return markBookingFailed(orgId, claimed, "CALENDAR_NOT_CONFIGURED", "No calendar provider is configured (CALENDAR_PROVIDER)");
    }

    const start = new Date(claimed.preferred_start);
    if (start.getTime() < Date.now() + MIN_LEAD_TIME_MS) {
        return markBookingFailed(orgId, claimed, "TIME_IN_PAST", "Requested meeting time has already passed");
    }
    const end = new Date(start.getTime() + Number(claimed.duration_minutes || 30) * 60000);

    try {
        const availability = await calendar.checkAvailability({
            calendarId: rep.calendarId,
            start,
            end,
            timezone: claimed.timezone,
        });
        if (!availability?.available) {
            return markBookingFailed(orgId, claimed, "REP_UNAVAILABLE", "The sales rep is busy at the requested time", {
                busy: availability?.busy || [],
            });
        }

        const eventId = deterministicEventId(orgId, claimed.id, claimed.booking_revision);
        const event = await calendar.createEvent({
            calendarId: rep.calendarId,
            eventId,
            summary: claimed.title || "Sales meeting",
            description: [
                `Lead: ${lead.name || ""} ${lead.company ? `(${lead.company})` : ""}`.trim(),
                claimed.preferred_text ? `Notes: ${claimed.preferred_text}` : null,
                "Booked via NOVA ASE.",
            ].filter(Boolean).join("\n"),
            start,
            end,
            timezone: claimed.timezone,
            attendees: [lead.email, rep.repEmail],
        });

        if (!event?.eventId || event.status !== "confirmed") {
            if (event?.eventId) {
                await calendar.cancelEvent({ calendarId: rep.calendarId, eventId: event.eventId }).catch(() => {});
            }
            return markBookingFailed(orgId, claimed, "EVENT_NOT_CONFIRMED", `Calendar returned status ${event?.status || "unknown"}`);
        }

        const confirmation = {
            provider: calendar.name,
            calendarId: rep.calendarId,
            calendarEventId: event.eventId,
            iCalUID: event.iCalUID || null,
            htmlLink: event.htmlLink || null,
            status: event.status,
            start: start.toISOString(),
            end: end.toISOString(),
            timezone: claimed.timezone,
            createdNew: Boolean(event.created),
            confirmedAt: new Date().toISOString(),
        };
        const booked = await SalesMeeting.transition(orgId, claimed.id, [claimed.status], MEETING_BOOKED, {
            rep_user_id: rep.repUserId || undefined,
            start_at: start,
            end_at: end,
            calendar_provider: calendar.name,
            calendar_id: rep.calendarId,
            calendar_event_id: event.eventId,
            calendar_event_link: event.htmlLink || null,
            confirmation,
            booked_at: new Date(),
            booking_claimed_at: null,
            last_error: null,
        });
        if (!booked) {
            await calendar.cancelEvent({ calendarId: rep.calendarId, eventId: event.eventId }).catch(() => {});
            throw new MeetingError("Meeting changed during booking; the calendar event was withdrawn", "CONFLICT", 409);
        }

        await recordEvent(booked, "MEETING_BOOKED", { actorUserId, confirmation }, `meeting_${booked.id}_booked_r${booked.booking_revision}`);
        await setHandoffStatus(lead, HANDOFF_STATUSES.MEETING_BOOKED, {
            orgId,
            source: "CALENDAR",
            reason: "Calendar event confirmed",
            meetingId: booked.id,
            actorUserId,
            confirmation,
            authoritative: true,
        });
        await followUpEngine.handleMeetingBooked(lead.id, orgId).catch(() => {});
        return { booked: true, alreadyBooked: false, meeting: booked, confirmation };
    } catch (err) {
        if (err instanceof MeetingError) {
            await SalesMeeting.releaseClaim(orgId, claimed.id).catch(() => {});
            throw err;
        }
        const code = err instanceof CalendarError ? err.code : "CALENDAR_ERROR";
        return markBookingFailed(orgId, claimed, code, err.message);
    }
}

export async function cancelMeeting(orgId, meetingId, { reason = null, actorUserId = null, provider = null } = {}) {
    const meeting = await loadMeeting(orgId, meetingId);
    if (meeting.status === MEETING_CANCELLED) return { cancelled: true, alreadyCancelled: true, meeting };

    if (meeting.status === MEETING_BOOKED && meeting.calendar_event_id) {
        const claimed = await SalesMeeting.claimForBooking(orgId, meeting.id, [MEETING_BOOKED]);
        if (!claimed) throw new MeetingError("Another change to this meeting is in progress", "BOOKING_IN_PROGRESS", 409);
        const calendar = provider || getCalendarProvider();
        try {
            await calendar.cancelEvent({ calendarId: meeting.calendar_id, eventId: meeting.calendar_event_id });
        } catch (err) {
            await SalesMeeting.update(orgId, meeting.id, { last_error: `CANCEL_FAILED: ${err.message}`.slice(0, 1000) });
            await SalesMeeting.releaseClaim(orgId, meeting.id);
            throw new MeetingError(`Calendar cancellation failed; meeting is still booked (${err.message})`, "CANCEL_FAILED", 502);
        }
    }

    const cancelled = await SalesMeeting.transition(
        orgId,
        meeting.id,
        [MEETING_REQUESTED, MEETING_PENDING, MEETING_BOOKED, BOOKING_FAILED],
        MEETING_CANCELLED,
        {
            cancelled_at: new Date(),
            cancel_reason: reason ? String(reason).slice(0, 500) : null,
            booking_claimed_at: null,
            booking_revision: Number(meeting.booking_revision || 0) + 1,
        }
    );
    if (!cancelled) throw new MeetingError("Meeting changed while cancelling; reload and retry", "CONFLICT", 409);

    await recordEvent(cancelled, "MEETING_CANCELLED", { reason, actorUserId, hadCalendarEvent: Boolean(meeting.calendar_event_id) }, `meeting_${cancelled.id}_cancelled`);
    await setHandoffStatus(meeting.lead_id, HANDOFF_STATUSES.MEETING_CANCELLED, {
        orgId,
        source: "CALENDAR",
        reason: reason || "Meeting cancelled",
        meetingId: meeting.id,
        actorUserId,
        authoritative: true,
    });
    return { cancelled: true, alreadyCancelled: false, meeting: cancelled };
}

const overlapsOnly = (busy, start, end) =>
    busy.filter((slot) => !(new Date(slot.start).getTime() === start.getTime() && new Date(slot.end).getTime() === end.getTime()));

/** Booked meetings move in the calendar first; the stored time only changes after the provider confirms. */
export async function rescheduleMeeting(orgId, meetingId, options = {}) {
    const { preferredStart, timezone, durationMinutes, actorUserId = null, provider = null } = options;
    const meeting = await loadMeeting(orgId, meetingId);
    if (meeting.status !== MEETING_BOOKED) {
        return { rescheduled: false, meeting: await setMeetingPreferences(orgId, meetingId, { preferredStart, timezone, durationMinutes, actorUserId }) };
    }

    const start = parseMeetingStart(preferredStart, timezone);
    const duration = normalizeDuration(durationMinutes ?? meeting.duration_minutes);
    const end = new Date(start.getTime() + duration * 60000);

    const claimed = await SalesMeeting.claimForBooking(orgId, meeting.id, [MEETING_BOOKED]);
    if (!claimed) throw new MeetingError("Another change to this meeting is in progress", "BOOKING_IN_PROGRESS", 409);

    const calendar = provider || getCalendarProvider();
    try {
        const availability = await calendar.checkAvailability({ calendarId: meeting.calendar_id, start, end, timezone });
        const conflicts = overlapsOnly(availability?.busy || [], new Date(meeting.start_at), new Date(meeting.end_at));
        if (conflicts.length) {
            throw new MeetingError("The sales rep is busy at the new time", "REP_UNAVAILABLE", 409, { busy: conflicts });
        }
        const event = await calendar.updateEvent({ calendarId: meeting.calendar_id, eventId: meeting.calendar_event_id, start, end, timezone });
        if (!event?.eventId || event.status !== "confirmed") {
            throw new MeetingError("Calendar did not confirm the new time", "EVENT_NOT_CONFIRMED", 502);
        }
        const confirmation = {
            ...(meeting.confirmation || {}),
            start: start.toISOString(),
            end: end.toISOString(),
            timezone,
            rescheduledAt: new Date().toISOString(),
            previousStart: meeting.start_at ? new Date(meeting.start_at).toISOString() : null,
        };
        const updated = await SalesMeeting.update(orgId, meeting.id, {
            preferred_start: start,
            timezone,
            duration_minutes: duration,
            start_at: start,
            end_at: end,
            confirmation,
            booking_claimed_at: null,
            last_error: null,
        });
        await recordEvent(updated, "MEETING_RESCHEDULED", { actorUserId, previousStart: confirmation.previousStart, start: confirmation.start }, `meeting_${updated.id}_rescheduled_${start.getTime()}`);
        return { rescheduled: true, meeting: updated };
    } catch (err) {
        await SalesMeeting.update(orgId, meeting.id, { last_error: `RESCHEDULE_FAILED: ${err.message}`.slice(0, 1000) }).catch(() => {});
        await SalesMeeting.releaseClaim(orgId, meeting.id).catch(() => {});
        if (err instanceof MeetingError) throw err;
        throw new MeetingError(`Calendar update failed; the meeting keeps its original time (${err.message})`, "RESCHEDULE_FAILED", 502);
    }
}

export async function listMeetings(orgId, { status = null, limit, offset } = {}) {
    const statuses = status ? String(status).split(",").map((s) => s.trim().toUpperCase()).filter((s) => Object.hasOwn(MEETING_STATUSES, s)) : null;
    return SalesMeeting.list(orgId, { statuses, limit, offset });
}

export async function getLeadMeetings(orgId, leadId) {
    return SalesMeeting.listForLead(orgId, leadId);
}

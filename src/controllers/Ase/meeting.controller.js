import { asyncHandler } from "../../utils/asyncHandler.js";
import {
    bookMeeting,
    cancelMeeting,
    getLeadMeetings,
    listMeetings,
    MeetingError,
    requestMeeting,
    rescheduleMeeting,
    setMeetingPreferences,
} from "../../services/ase/meetingBooking.service.js";
import { SalesMeeting } from "../../models/sales-meeting.model.js";
import { Lead } from "../../models/lead.model.js";

const orgOf = (req) => Number(req.user?.organization_id || 1);
const actorOf = (req) => (/^\d+$/.test(String(req.user?.id || "")) ? Number(req.user.id) : null);

const preferences = (body = {}) => ({
    preferredStart: body.preferredStart ?? body.start ?? null,
    timezone: body.timezone ?? null,
    durationMinutes: body.durationMinutes ?? null,
    repUserId: body.repUserId ?? null,
    preferredText: body.notes ?? body.preferredText ?? null,
});

const handle = (fn, okStatus = 200) => asyncHandler(async (req, res) => {
    try {
        const data = await fn(req);
        if (data?.booked === false && data.failure) {
            const status = data.failure.code === "REP_UNAVAILABLE" ? 409
                : data.failure.code === "CALENDAR_NOT_CONFIGURED" ? 503
                    : 502;
            return res.status(status).json({ success: false, error: data.failure.message, code: data.failure.code, data });
        }
        return res.status(okStatus).json({ success: true, data });
    } catch (err) {
        if (err instanceof MeetingError) {
            return res.status(err.httpStatus).json({ error: err.message, code: err.code, details: err.details || undefined });
        }
        console.error("[Meeting]", err.message);
        return res.status(500).json({ error: "Meeting operation failed" });
    }
});

export const listOrgMeetings = handle((req) =>
    listMeetings(orgOf(req), { status: req.query.status || null, limit: req.query.limit, offset: req.query.offset })
);

export const getMeeting = handle(async (req) => {
    const meeting = await SalesMeeting.findById(orgOf(req), req.params.id);
    if (!meeting) throw new MeetingError("Meeting not found", "NOT_FOUND", 404);
    return meeting;
});

export const getLeadMeetingState = handle(async (req) => {
    const orgId = orgOf(req);
    const lead = await Lead.findById(Number(req.params.leadId), orgId);
    if (!lead) throw new MeetingError("Lead not found", "LEAD_NOT_FOUND", 404);
    return {
        handoffStatus: lead.handoff_status || null,
        handoffUpdatedAt: lead.handoff_updated_at || null,
        meetings: await getLeadMeetings(orgId, lead.id),
    };
});

export const createLeadMeetingRequest = handle((req) =>
    requestMeeting(orgOf(req), req.params.leadId, {
        ...preferences(req.body),
        source: "MANUAL",
        actorUserId: actorOf(req),
    }), 201
);

export const updateMeetingPreferences = handle((req) =>
    setMeetingPreferences(orgOf(req), req.params.id, { ...preferences(req.body), actorUserId: actorOf(req) })
);

export const bookMeetingNow = handle((req) => bookMeeting(orgOf(req), req.params.id, { actorUserId: actorOf(req) }));

export const cancelMeetingById = handle((req) =>
    cancelMeeting(orgOf(req), req.params.id, { reason: req.body?.reason || null, actorUserId: actorOf(req) })
);

export const rescheduleMeetingById = handle((req) =>
    rescheduleMeeting(orgOf(req), req.params.id, { ...preferences(req.body), actorUserId: actorOf(req) })
);

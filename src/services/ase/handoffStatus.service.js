import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { HANDOFF_STATUSES } from "../../schema/sales-meeting.schema.js";
import { getIo } from "../../socket/socketServer.js";

export { HANDOFF_STATUSES };

const RANK = {
    [HANDOFF_STATUSES.MEETING_CANCELLED]: 0,
    [HANDOFF_STATUSES.INTERESTED]: 1,
    [HANDOFF_STATUSES.HANDOFF_REQUESTED]: 2,
    [HANDOFF_STATUSES.CALLBACK_PENDING]: 3,
    [HANDOFF_STATUSES.MEETING_REQUESTED]: 4,
    [HANDOFF_STATUSES.MEETING_PENDING]: 5,
    [HANDOFF_STATUSES.BOOKING_FAILED]: 5,
    [HANDOFF_STATUSES.MEETING_BOOKED]: 6,
};

export class HandoffStatusError extends Error {
    constructor(message, code) {
        super(message);
        this.name = "HandoffStatusError";
        this.code = code;
    }
}

/**
 * Detection paths (voice/email interest, callback, transfer) only move a lead's handoff status
 * forward; they never downgrade a meeting. The meeting service passes `authoritative: true`
 * because it owns MEETING_* transitions, and MEETING_BOOKED additionally requires a calendar
 * confirmation (event id) so interest can never be reported as a booked meeting.
 */
export function shouldApplyHandoffStatus(current, next, { authoritative = false } = {}) {
    if (!Object.hasOwn(RANK, next)) return false;
    if (current === next) return false;
    if (authoritative) return true;
    if (!current || !Object.hasOwn(RANK, current)) return true;
    if (current === HANDOFF_STATUSES.MEETING_CANCELLED) return true;
    return RANK[next] > RANK[current];
}

export async function setHandoffStatus(leadOrId, status, options = {}) {
    const {
        source = "SYSTEM",
        reason = null,
        authoritative = false,
        confirmation = null,
        meetingId = null,
        callId = null,
        actorUserId = null,
        orgId: orgIdOverride = null,
    } = options;

    if (!Object.hasOwn(RANK, status)) {
        throw new HandoffStatusError(`Unknown handoff status: ${status}`, "INVALID_HANDOFF_STATUS");
    }
    if (status === HANDOFF_STATUSES.MEETING_BOOKED && !confirmation?.calendarEventId) {
        throw new HandoffStatusError(
            "MEETING_BOOKED requires a calendar booking confirmation",
            "BOOKING_CONFIRMATION_REQUIRED"
        );
    }

    const orgId = Number(orgIdOverride || leadOrId?.organization_id || 1);
    const lead = typeof leadOrId === "object" && leadOrId?.id
        ? await Lead.findById(leadOrId.id, orgId)
        : await Lead.findById(Number(leadOrId), orgId);
    if (!lead) return { changed: false, reason: "lead_not_found" };

    const previous = lead.handoff_status || null;
    if (!shouldApplyHandoffStatus(previous, status, { authoritative })) {
        return { changed: false, previous, status: previous };
    }

    await Lead.updateById(lead.id, { handoff_status: status, handoff_updated_at: new Date() }, orgId);
    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        channel: String(source || "SYSTEM").toUpperCase().slice(0, 16),
        event_type: "HANDOFF_STATUS_CHANGED",
        status,
        payload: {
            from: previous,
            to: status,
            reason,
            meetingId,
            callId,
            actorUserId,
            calendarEventId: confirmation?.calendarEventId || null,
        },
    }).catch((err) => console.warn("[Handoff] Status event failed:", err.message));

    getIo()?.to(`org:${orgId}`).emit("lead:handoff_status", { leadId: lead.id, from: previous, status, meetingId });
    return { changed: true, previous, status };
}

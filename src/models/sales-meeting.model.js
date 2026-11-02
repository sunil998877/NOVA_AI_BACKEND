import { execute, query } from "../config/db.js";
import { salesMeetingSchema, OPEN_MEETING_STATUSES } from "../schema/sales-meeting.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = salesMeetingSchema;

const BOOKING_CLAIM_TTL_SECONDS = 120;

const WRITABLE = new Set([
    "rep_user_id",
    "title",
    "preferred_text",
    "preferred_start",
    "timezone",
    "duration_minutes",
    "start_at",
    "end_at",
    "calendar_provider",
    "calendar_id",
    "calendar_event_id",
    "calendar_event_link",
    "confirmation",
    "booking_revision",
    "booking_claimed_at",
    "last_error",
    "booked_at",
    "cancelled_at",
    "cancel_reason",
]);

const parseJson = (value, fallback = null) => {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const toMeeting = (row) => {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.confirmation = parseJson(row.confirmation, null);
    return mapped;
};

function serialize(field, value) {
    if (field === "confirmation") return value == null ? null : JSON.stringify(value);
    return value;
}

function buildSets(fields) {
    const sets = [];
    const params = [];
    for (const [field, value] of Object.entries(fields)) {
        if (!WRITABLE.has(field) || value === undefined) continue;
        sets.push(`${field} = ?`);
        params.push(serialize(field, value));
    }
    return { sets, params };
}

export const SalesMeeting = {
    async findById(orgId, id) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND id = ? LIMIT 1`,
            [Number(orgId), Number(id)]
        );
        return toMeeting(rows[0]);
    },

    async findOpenForLead(orgId, leadId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ? AND lead_id = ? AND status IN (${OPEN_MEETING_STATUSES.map(() => "?").join(", ")})
             ORDER BY id DESC LIMIT 1`,
            [Number(orgId), Number(leadId), ...OPEN_MEETING_STATUSES]
        );
        return toMeeting(rows[0]);
    },

    async listForLead(orgId, leadId, limit = 20) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND lead_id = ?
             ORDER BY id DESC LIMIT ?`,
            [Number(orgId), Number(leadId), Math.min(Math.max(Number(limit) || 20, 1), 100)]
        );
        return rows.map(toMeeting);
    },

    async list(orgId, { statuses = null, limit = 50, offset = 0 } = {}) {
        const where = ["m.organization_id = ?"];
        const params = [Number(orgId)];
        if (statuses?.length) {
            where.push(`m.status IN (${statuses.map(() => "?").join(", ")})`);
            params.push(...statuses);
        }
        params.push(Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0));
        const rows = await query(
            `SELECT m.*, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company
             FROM ${table} m
             LEFT JOIN leads l ON l.id = m.lead_id AND l.organization_id = m.organization_id
             WHERE ${where.join(" AND ")}
             ORDER BY COALESCE(m.start_at, m.preferred_start, m.created_at) ASC, m.id DESC
             LIMIT ? OFFSET ?`,
            params
        );
        return rows.map(toMeeting);
    },

    /** One open meeting per lead (generated open_slot key); a concurrent request returns the existing one. */
    async createOnce(data) {
        const orgId = Number(data.organization_id);
        try {
            const result = await execute(
                `INSERT INTO ${table}
                 (organization_id, lead_id, rep_user_id, source, source_ref, status, title,
                  preferred_text, preferred_start, timezone, duration_minutes, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    orgId,
                    Number(data.lead_id),
                    data.rep_user_id ? Number(data.rep_user_id) : null,
                    String(data.source || "MANUAL").slice(0, 16),
                    data.source_ref ? String(data.source_ref).slice(0, 128) : null,
                    data.status,
                    data.title ? String(data.title).slice(0, 255) : null,
                    data.preferred_text ? String(data.preferred_text).slice(0, 500) : null,
                    data.preferred_start || null,
                    data.timezone || null,
                    Number(data.duration_minutes) || 30,
                    data.created_by ? Number(data.created_by) : null,
                ]
            );
            return { created: true, meeting: await this.findById(orgId, result.insertId) };
        } catch (error) {
            if (error.code === "ER_DUP_ENTRY" || error.errno === 1062) {
                return { created: false, meeting: await this.findOpenForLead(orgId, data.lead_id) };
            }
            throw error;
        }
    },

    /** Compare-and-set status change; returns null when the meeting is no longer in one of `fromStatuses`. */
    async transition(orgId, id, fromStatuses, toStatus, fields = {}) {
        const { sets, params } = buildSets(fields);
        sets.unshift("status = ?");
        params.unshift(toStatus);
        params.push(Number(orgId), Number(id), ...fromStatuses);
        const result = await execute(
            `UPDATE ${table} SET ${sets.join(", ")}
             WHERE organization_id = ? AND id = ? AND status IN (${fromStatuses.map(() => "?").join(", ")})`,
            params
        );
        if (!result?.affectedRows) return null;
        return this.findById(orgId, id);
    },

    async update(orgId, id, fields = {}) {
        const { sets, params } = buildSets(fields);
        if (!sets.length) return this.findById(orgId, id);
        params.push(Number(orgId), Number(id));
        await execute(`UPDATE ${table} SET ${sets.join(", ")} WHERE organization_id = ? AND id = ?`, params);
        return this.findById(orgId, id);
    },

    /**
     * Exclusive booking claim: only one caller at a time may talk to the calendar for a meeting.
     * A stale claim (crashed worker) expires after BOOKING_CLAIM_TTL_SECONDS.
     */
    async claimForBooking(orgId, id, fromStatuses) {
        const result = await execute(
            `UPDATE ${table}
             SET booking_claimed_at = UTC_TIMESTAMP(), attempts = attempts + 1
             WHERE organization_id = ? AND id = ?
               AND status IN (${fromStatuses.map(() => "?").join(", ")})
               AND (booking_claimed_at IS NULL OR booking_claimed_at < UTC_TIMESTAMP() - INTERVAL ${BOOKING_CLAIM_TTL_SECONDS} SECOND)`,
            [Number(orgId), Number(id), ...fromStatuses]
        );
        if (!result?.affectedRows) return null;
        return this.findById(orgId, id);
    },

    async releaseClaim(orgId, id) {
        await execute(`UPDATE ${table} SET booking_claimed_at = NULL WHERE organization_id = ? AND id = ?`, [
            Number(orgId),
            Number(id),
        ]);
    },
};

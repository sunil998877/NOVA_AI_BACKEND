import { execute, query } from "../config/db.js";
import { callbackSchema } from "../schema/callback.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns, updatable } = callbackSchema;
const UPDATABLE = new Set(updatable);
const TERMINAL_LEAD_STATUSES = new Set([
    "CLOSED_WON",
    "CLOSED_LOST",
    "CLOSED_UNQUALIFIED",
    "SUPPRESSED_DNC",
]);

export function isHandoffBackfillLead(lead = {}) {
    const status = String(lead.status || "").toUpperCase();
    const nextAction = String(lead.next_action || "").toUpperCase();
    if (lead.do_not_contact) return false;
    if (TERMINAL_LEAD_STATUSES.has(status)) return false;
    return status === "CALLBACK_SCHEDULED"
        || nextAction === "REP_CALLBACK"
        || Boolean(lead.callback_due);
}

export const Callback = {
    async create(data) {
        const orgId = Number(data.organization_id || 1);
        const leadId = Number(data.lead_id);
        const activeStatuses = ["OPEN", "SCHEDULED", "DUE", "IN_PROGRESS", "OVERDUE", "REQUESTED"];

        const existingActive = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ? AND lead_id = ? AND status IN (${activeStatuses.map(() => "?").join(",")})
             ORDER BY due_at ASC LIMIT 1`,
            [orgId, leadId, ...activeStatuses]
        );

        if (existingActive && existingActive.length > 0) {
            const existing = existingActive[0];
            const updates = {};
            if (data.call_id && !existing.call_id) updates.call_id = Number(data.call_id);
            if (data.notes && data.notes !== existing.notes) {
                updates.notes = existing.notes ? `${existing.notes} | ${data.notes}` : data.notes;
            }
            if (data.due_at && new Date(data.due_at).getTime() !== new Date(existing.due_at).getTime()) {
                updates.due_at = data.due_at;
            }
            if (Object.keys(updates).length > 0) {
                await this.updateById(orgId, existing.id, updates);
            }
            const updatedRows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [existing.id]);
            return mapRow(updatedRows[0]);
        }

        const dueAt = data.due_at ? new Date(data.due_at) : new Date(Date.now() + 30 * 60 * 1000);
        const requestedAt = data.requested_at ? new Date(data.requested_at) : new Date();
        const initialStatus = data.status || "OPEN";
        const isPastDue = dueAt.getTime() < Date.now();
        const slaStatus = isPastDue ? "BREACHED" : "ON_TRACK";
        const slaBreachedAt = isPastDue ? new Date() : null;

        const result = await execute(
            `INSERT INTO ${table} (
                organization_id, lead_id, call_id, assigned_rep_id, due_at, requested_at,
                status, actual_outcome, follow_up_action, sla_status, sla_breached_at,
                notes, source_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orgId,
                leadId,
                data.call_id ? Number(data.call_id) : null,
                data.assigned_rep_id ? Number(data.assigned_rep_id) : null,
                dueAt,
                requestedAt,
                initialStatus,
                data.actual_outcome || null,
                data.follow_up_action || null,
                slaStatus,
                slaBreachedAt,
                data.notes || null,
                data.source_event_id ? Number(data.source_event_id) : null,
            ]
        );

        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [result.insertId]);
        return mapRow(rows[0]);
    },

    async hasActiveCallback(arg1, arg2) {
        const orgId = arg2 !== undefined ? Number(arg1) : 1;
        const leadId = arg2 !== undefined ? Number(arg2) : Number(arg1);
        const activeStatuses = ["OPEN", "SCHEDULED", "DUE", "IN_PROGRESS", "OVERDUE", "REQUESTED"];
        const rows = await query(
            `SELECT id FROM ${table}
             WHERE organization_id = ? AND lead_id = ? AND status IN (${activeStatuses.map(() => "?").join(",")})
             LIMIT 1`,
            [Number(orgId), Number(leadId), ...activeStatuses]
        );
        return Boolean(rows && rows.length > 0);
    },

    async updateSlaStatuses(orgId = 1) {
        const result = await execute(
            `UPDATE ${table}
             SET sla_status = 'BREACHED',
                 sla_breached_at = COALESCE(sla_breached_at, NOW())
             WHERE organization_id = ?
               AND status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
               AND due_at < NOW()
               AND sla_status != 'BREACHED'`,
            [Number(orgId)]
        );
        return Number(result?.affectedRows || 0);
    },

    async findById(arg1, arg2) {
        const orgId = arg2 !== undefined ? Number(arg1) : 1;
        const id = arg2 !== undefined ? Number(arg2) : Number(arg1);
        const rows = await query(
            `SELECT c.*, l.name as lead_name, l.email as lead_email, l.phone as lead_phone, l.company as lead_company,
                    l.priority as priority, l.priority as lead_priority, l.health as lead_health, l.status as lead_status,
                    l.source as lead_source, u.fullName as rep_name
             FROM ${table} c
             LEFT JOIN leads l ON c.lead_id = l.id
             LEFT JOIN users u ON c.assigned_rep_id = u.id
             WHERE c.organization_id = ? AND c.id = ? LIMIT 1`,
            [Number(orgId), Number(id)]
        );
        return rows[0] ? mapRow(rows[0]) : null;
    },

    async listOverdue(limit = 50) {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const rows = await query(
            `SELECT c.*, l.name as lead_name, l.email as lead_email, l.phone as lead_phone, l.company as lead_company,
                    l.priority as priority, l.health as lead_health, l.status as lead_status
             FROM ${table} c
             LEFT JOIN leads l ON c.lead_id = l.id
             WHERE c.status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED') AND c.due_at < NOW()
             ORDER BY c.due_at ASC
             LIMIT ${safeLimit}`
        );
        return rows.map(mapRow);
    },

    async list(orgId, { status = "", assigned_rep_id = null, overdue = false, limit = 50, skip = 0 } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const safeSkip = Math.max(Number(skip) || 0, 0);
        const where = ["c.organization_id = ?"];
        const params = [Number(orgId)];

        if (status) {
            where.push("c.status = ?");
            params.push(status);
        }
        if (assigned_rep_id) {
            where.push("c.assigned_rep_id = ?");
            params.push(Number(assigned_rep_id));
        }
        if (overdue) {
            where.push("c.status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED') AND c.due_at < NOW()");
        }

        const whereSql = where.join(" AND ");
        const rows = await query(
            `SELECT c.*, l.name as lead_name, l.email as lead_email, l.phone as lead_phone, l.company as lead_company,
                    l.priority as priority, l.priority as lead_priority, l.health as lead_health, l.status as lead_status,
                    l.source as lead_source, u.fullName as rep_name
             FROM ${table} c
             LEFT JOIN leads l ON c.lead_id = l.id
             LEFT JOIN users u ON c.assigned_rep_id = u.id
             WHERE ${whereSql}
             ORDER BY c.due_at ASC
             LIMIT ${safeLimit} OFFSET ${safeSkip}`,
            params
        );
        return rows.map(mapRow);
    },

    async update(arg1, arg2, arg3) {
        return this.updateById(arg1, arg2, arg3);
    },

    async updateById(arg1, arg2, arg3) {
        const orgId = arg3 !== undefined ? Number(arg1) : 1;
        const id = arg3 !== undefined ? Number(arg2) : Number(arg1);
        const fields = arg3 !== undefined ? arg3 : arg2;
        const entries = Object.entries(fields || {}).filter(
            ([key, value]) => UPDATABLE.has(key) && value !== undefined
        );
        if (entries.length === 0) return this.findById(orgId, id);

        const sets = entries.map(([key]) => `${key} = ?`).join(", ");
        const values = entries.map(([, value]) => value);
        await execute(`UPDATE ${table} SET ${sets} WHERE organization_id = ? AND id = ?`, [
            ...values,
            Number(orgId),
            Number(id),
        ]);
        return this.findById(orgId, id);
    },

    async ensureHandoffQueue(orgId) {
        const activeStatuses = ["OPEN", "SCHEDULED", "DUE", "IN_PROGRESS", "OVERDUE", "REQUESTED"];
        const leads = await query(
            `SELECT l.id, l.assigned_rep_id, l.callback_due, l.status
             FROM leads l
             WHERE l.organization_id = ?
               AND l.do_not_contact = 0
               AND l.status NOT IN ('CLOSED_WON', 'CLOSED_LOST', 'CLOSED_UNQUALIFIED', 'SUPPRESSED_DNC')
               AND (
                    l.status = 'CALLBACK_SCHEDULED'
                    OR l.next_action = 'REP_CALLBACK'
                    OR l.callback_due IS NOT NULL
               )
               AND NOT EXISTS (
                    SELECT 1 FROM ${table} c
                    WHERE c.organization_id = l.organization_id
                      AND c.lead_id = l.id
                      AND c.status IN (${activeStatuses.map(() => "?").join(",")})
               )`,
            [Number(orgId), ...activeStatuses]
        );

        for (const lead of leads) {
            const dueAt = lead.callback_due
                ? new Date(lead.callback_due)
                : new Date(Date.now() + 30 * 60 * 1000);

            const recentCompleted = await query(
                `SELECT id FROM ${table}
                 WHERE organization_id = ? AND lead_id = ? AND status = 'COMPLETED'
                   AND completed_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
                 LIMIT 1`,
                [Number(orgId), Number(lead.id)]
            );

            if (recentCompleted && recentCompleted.length > 0 && !lead.callback_due) {
                continue;
            }

            await this.create({
                organization_id: orgId,
                lead_id: lead.id,
                assigned_rep_id: lead.assigned_rep_id,
                due_at: dueAt,
                requested_at: new Date(),
                status: dueAt.getTime() < Date.now() ? "OVERDUE" : "OPEN",
                notes: "Human follow-up is waiting for this lead.",
            });
        }
    },

    async cancelOpenForLead(orgId, leadId, reason = "Cancelled") {
        const note = ` | ${String(reason || "Cancelled").slice(0, 180)}`;
        const result = await execute(
            `UPDATE ${table}
             SET status = 'CANCELLED',
                 notes = CONCAT(IFNULL(notes, ''), ?)
             WHERE organization_id = ? AND lead_id = ?
               AND status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')`,
            [note, Number(orgId), Number(leadId)]
        );
        return Number(result?.affectedRows || 0);
    },

    async countOpenByRep(orgId) {
        const rows = await query(
            `SELECT assigned_rep_id, COUNT(*) AS total FROM ${table}
             WHERE organization_id = ?
               AND assigned_rep_id IS NOT NULL
               AND status IN ('OPEN', 'SCHEDULED', 'DUE', 'IN_PROGRESS', 'OVERDUE', 'REQUESTED')
             GROUP BY assigned_rep_id`,
            [Number(orgId || 1)]
        );
        const counts = {};
        for (const row of rows || []) {
            counts[Number(row.assigned_rep_id)] = Number(row.total || 0);
        }
        return counts;
    },

    async countStats(orgId) {
        const rows = await query(
            `SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status IN ('OPEN', 'SCHEDULED', 'DUE', 'REQUESTED') AND due_at >= NOW() THEN 1 ELSE 0 END) as open_count,
                SUM(CASE WHEN status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED') AND due_at < NOW() THEN 1 ELSE 0 END) as overdue_count,
                SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_count
             FROM ${table} WHERE organization_id = ?`,
            [Number(orgId)]
        );
        return mapRow(rows[0]) || { total: 0, open_count: 0, overdue_count: 0, completed_count: 0 };
    },
};

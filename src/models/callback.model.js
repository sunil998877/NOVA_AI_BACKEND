import { execute, query } from "../config/db.js";
import { callbackSchema } from "../schema/callback.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns, updatable } = callbackSchema;
const UPDATABLE = new Set(updatable);

export const Callback = {
    async create(data) {
        const result = await execute(
            `INSERT INTO ${table} (organization_id, lead_id, assigned_rep_id, due_at, status, notes, source_event_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                Number(data.organization_id),
                Number(data.lead_id),
                data.assigned_rep_id ? Number(data.assigned_rep_id) : null,
                data.due_at,
                data.status || "OPEN",
                data.notes || null,
                data.source_event_id ? Number(data.source_event_id) : null,
            ]
        );
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [result.insertId]);
        return mapRow(rows[0]);
    },

    async findById(orgId, id) {
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
        return mapRow(rows[0]);
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
            where.push("c.status IN ('OPEN', 'IN_PROGRESS') AND c.due_at < NOW()");
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

    async updateById(orgId, id, fields) {
        const entries = Object.entries(fields).filter(
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

    async countStats(orgId) {
        const rows = await query(
            `SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_count,
                SUM(CASE WHEN status IN ('OPEN', 'IN_PROGRESS') AND due_at < NOW() THEN 1 ELSE 0 END) as overdue_count,
                SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_count
             FROM ${table} WHERE organization_id = ?`,
            [Number(orgId)]
        );
        return mapRow(rows[0]) || { total: 0, open_count: 0, overdue_count: 0, completed_count: 0 };
    },
};

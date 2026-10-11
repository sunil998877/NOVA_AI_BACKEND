import { execute, query } from "../config/db.js";
import { leadEventSchema } from "../schema/lead-event.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = leadEventSchema;

const parseJson = (val) => {
    if (!val) return null;
    if (typeof val === "object") return val;
    try {
        return JSON.parse(val);
    } catch {
        return val;
    }
};

const toEvent = (row) => {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.payload = parseJson(row.payload);
    return mapped;
};

export const LeadEvent = {
    async create({ organization_id, lead_id, user_id = null, channel = "SYSTEM", event_type, status = null, payload = null }) {
        const result = await execute(
            `INSERT INTO ${table} (organization_id, lead_id, user_id, channel, event_type, status, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                Number(organization_id),
                Number(lead_id),
                user_id ? Number(user_id) : null,
                channel,
                event_type,
                status,
                payload ? JSON.stringify(payload) : null,
            ]
        );
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [result.insertId]);
        return toEvent(rows[0]);
    },

    async listByLead(orgId, leadId, limit = 100) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ? AND lead_id = ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [Number(orgId), Number(leadId), Math.min(Number(limit) || 100, 500)]
        );
        return rows.map(toEvent);
    },

    async listRecent(orgId, limit = 50) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [Number(orgId), Math.min(Number(limit) || 50, 200)]
        );
        return rows.map(toEvent);
    },
};

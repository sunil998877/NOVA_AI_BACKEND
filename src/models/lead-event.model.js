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
    async create({ organization_id, lead_id, user_id = null, channel = "SYSTEM", event_type, status = null, payload = null, idempotency_key = null, created_at = new Date() }) {
        const orgId = Number(organization_id);
        const lId = Number(lead_id);
        const safeKey = idempotency_key ? String(idempotency_key).trim() : null;

        if (safeKey) {
            try {
                const existing = await query(
                    `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
                    [orgId, safeKey]
                );
                if (existing && existing.length > 0) {
                    return toEvent(existing[0]);
                }
            } catch (_) {}
        }

        try {
            const result = await execute(
                `INSERT INTO ${table} (organization_id, lead_id, user_id, channel, event_type, status, payload, idempotency_key, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    orgId,
                    lId,
                    user_id ? Number(user_id) : null,
                    channel,
                    event_type,
                    status,
                    payload ? JSON.stringify(payload) : null,
                    safeKey,
                    created_at,
                ]
            );
            const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [result.insertId]);
            return toEvent(rows[0]);
        } catch (error) {
            if (safeKey && (error.code === "ER_DUP_ENTRY" || error.errno === 1062)) {
                const existing = await query(
                    `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
                    [orgId, safeKey]
                );
                if (existing && existing.length > 0) {
                    return toEvent(existing[0]);
                }
            }
            throw error;
        }
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

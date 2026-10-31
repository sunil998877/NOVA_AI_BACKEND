import { execute, query } from "../config/db.js";
import { consentEventSchema } from "../schema/consent-event.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = consentEventSchema;

export const ConsentEvent = {
    async create({ organization_id, lead_id, channel, status, source, actor_user_id = null }) {
        const result = await execute(
            `INSERT INTO ${table} (organization_id, lead_id, channel, status, source, actor_user_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                Number(organization_id),
                Number(lead_id),
                String(channel).toUpperCase(),
                String(status).toUpperCase(),
                String(source),
                actor_user_id ? Number(actor_user_id) : null,
            ]
        );
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [result.insertId]);
        return mapRow(rows[0]);
    },

    async listByLead(orgId, leadId, limit = 50) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ? AND lead_id = ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [Number(orgId), Number(leadId), Math.min(Number(limit) || 50, 200)]
        );
        return rows.map(mapRow);
    },

    async listByOrg(orgId, limit = 500) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [Number(orgId), Math.min(Math.max(Number(limit) || 500, 1), 2000)]
        );
        return rows.map(mapRow);
    },
};

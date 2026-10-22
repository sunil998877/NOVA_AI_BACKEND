import { execute, query } from "../config/db.js";
import { suppressionSchema } from "../schema/suppression.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = suppressionSchema;

export const Suppression = {
    async isSuppressed(orgId, { email, phone, domain } = {}) {
        const conditions = [];
        const params = [Number(orgId)];

        if (email) {
            conditions.push("(type = 'EMAIL' AND value = ?)");
            params.push(String(email).toLowerCase().trim());
        }
        if (phone) {
            conditions.push("(type = 'PHONE' AND value = ?)");
            params.push(String(phone).trim());
        }
        if (domain) {
            conditions.push("(type = 'DOMAIN' AND value = ?)");
            params.push(String(domain).toLowerCase().trim());
        }

        if (conditions.length === 0) return false;

        const rows = await query(
            `SELECT id, type, value, reason FROM ${table} WHERE organization_id = ? AND (${conditions.join(" OR ")}) LIMIT 1`,
            params
        );
        return rows.length > 0 ? mapRow(rows[0]) : false;
    },

    async add(orgId, typeOrPayload, value = null, reason = "DNC request") {
        let type = typeOrPayload;
        let cleanVal = value;
        let rsn = reason;

        if (typeof typeOrPayload === "object" && typeOrPayload !== null) {
            type = typeOrPayload.type || "EMAIL";
            cleanVal = typeOrPayload.email || typeOrPayload.value || typeOrPayload.phone;
            rsn = typeOrPayload.reason || reason;
        }

        if (!cleanVal) return false;
        const normalizedVal = String(cleanVal).trim().toLowerCase();
        await execute(
            `INSERT INTO ${table} (organization_id, type, value, reason)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE reason = VALUES(reason)`,
            [Number(orgId), String(type).toUpperCase(), normalizedVal, rsn]
        );
        return true;
    },

    async list(orgId, { limit = 100, skip = 0 } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
        const safeSkip = Math.max(Number(skip) || 0, 0);
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [Number(orgId), safeLimit, safeSkip]
        );
        return rows.map(mapRow);
    },

    async remove(orgId, id) {
        const result = await execute(`DELETE FROM ${table} WHERE organization_id = ? AND id = ?`, [
            Number(orgId),
            Number(id),
        ]);
        return result.affectedRows > 0;
    },
};

import { execute, query } from "../config/db.js";
import { salesPlaybookSchema } from "../schema/sales-playbook.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = salesPlaybookSchema;

const parseJson = (value, fallback) => {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const toPlaybook = (row) => {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.content = parseJson(row.content, {});
    mapped.missing_fields = parseJson(row.missing_fields, []);
    return mapped;
};

export const SalesPlaybook = {
    async findByOrg(orgId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? LIMIT 1`,
            [Number(orgId)]
        );
        return rows[0] ? toPlaybook(rows[0]) : null;
    },

    async upsert(orgId, { content, status, missingFields }) {
        const existing = await this.findByOrg(orgId);
        const nextStatus = status || existing?.status || "DRAFT";
        const payload = JSON.stringify(content || {});
        const missing = JSON.stringify(missingFields || []);

        if (existing) {
            const version = Number(existing.version || 1) + 1;
            await execute(
                `UPDATE ${table}
                 SET version = ?, status = ?, content = ?, missing_fields = ?
                 WHERE organization_id = ?`,
                [version, nextStatus, payload, missing, Number(orgId)]
            );
            return this.findByOrg(orgId);
        }

        await execute(
            `INSERT INTO ${table} (organization_id, version, status, content, missing_fields)
             VALUES (?, 1, ?, ?, ?)`,
            [Number(orgId), nextStatus, payload, missing]
        );
        return this.findByOrg(orgId);
    },
};

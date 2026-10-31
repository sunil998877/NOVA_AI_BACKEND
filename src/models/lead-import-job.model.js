import { execute, query } from "../config/db.js";
import { leadImportJobSchema } from "../schema/lead-import-job.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = leadImportJobSchema;

const parseJson = (value, fallback = null) => {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const toJob = (row) => {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.error_summary = parseJson(row.error_summary, []);
    mapped.update_existing = Boolean(row.update_existing);
    delete mapped.payload;
    return mapped;
};

export const LeadImportJob = {
    async create({ organizationId, userId = null, source = "CSV_IMPORT", updateExisting = false, totalRows = 0, payload = null }) {
        const result = await execute(
            `INSERT INTO ${table}
             (organization_id, user_id, source, status, update_existing, total_rows, payload)
             VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
            [
                Number(organizationId || 1),
                userId ? Number(userId) : null,
                source,
                updateExisting ? 1 : 0,
                Number(totalRows || 0),
                payload ? JSON.stringify(payload) : null,
            ]
        );
        return this.findById(result.insertId, organizationId);
    },

    async findById(id, orgId) {
        const sql = orgId
            ? `SELECT ${columns} FROM ${table} WHERE id = ? AND organization_id = ? LIMIT 1`
            : `SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`;
        const params = orgId ? [Number(id), Number(orgId)] : [Number(id)];
        const rows = await query(sql, params);
        return rows[0] ? toJob(rows[0]) : null;
    },

    async getPayload(id, orgId) {
        const rows = await query(
            `SELECT payload FROM ${table} WHERE id = ? AND organization_id = ? LIMIT 1`,
            [Number(id), Number(orgId)]
        );
        return parseJson(rows[0]?.payload, null);
    },

    async updateById(id, orgId, fields) {
        const allowed = [
            "status",
            "processed",
            "accepted",
            "created_count",
            "updated_count",
            "skipped",
            "rejected",
            "failed",
            "error_summary",
            "completed_at",
        ];
        const sets = [];
        const params = [];
        for (const key of allowed) {
            if (fields[key] === undefined) continue;
            sets.push(`${key} = ?`);
            params.push(key === "error_summary" ? JSON.stringify(fields[key]) : fields[key]);
        }
        if (!sets.length) return this.findById(id, orgId);
        params.push(Number(id), Number(orgId));
        await execute(
            `UPDATE ${table} SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`,
            params
        );
        return this.findById(id, orgId);
    },

    async listRecent(orgId, limit = 20) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? ORDER BY id DESC LIMIT ?`,
            [Number(orgId), Number(limit)]
        );
        return rows.map(toJob);
    },
};

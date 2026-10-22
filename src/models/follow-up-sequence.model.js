import { execute, query } from "../config/db.js";
import { followUpSequenceSchema } from "../schema/follow-up.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = followUpSequenceSchema;

function parseJson(val, fallback) {
    if (!val) return fallback;
    if (typeof val === "object") return val;
    try {
        return JSON.parse(val);
    } catch {
        return fallback;
    }
}

function mapSequence(row) {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.steps_config = parseJson(row.steps_config, []);
    mapped.sending_days = parseJson(row.sending_days, [1, 2, 3, 4, 5]);
    mapped.is_active = Boolean(row.is_active);
    return mapped;
}

export const FollowUpSequence = {
    async findById(id, orgId = 1) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE id = ? AND organization_id = ? LIMIT 1`,
            [Number(id), Number(orgId)]
        );
        return mapSequence(rows[0]);
    },

    async findActiveDefault(orgId = 1) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`,
            [Number(orgId)]
        );
        return mapSequence(rows[0]);
    },

    async list(orgId = 1) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? ORDER BY id ASC`,
            [Number(orgId)]
        );
        return rows.map(mapSequence);
    },

    async create(data) {
        const orgId = Number(data.organization_id || 1);
        const result = await execute(
            `INSERT INTO ${table} (
                organization_id, name, description, is_active, steps_config,
                sending_window_start, sending_window_end, sending_days, timezone
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orgId,
                String(data.name || "Custom Follow-Up Sequence"),
                data.description || null,
                data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1,
                JSON.stringify(data.steps_config || []),
                data.sending_window_start || "09:00",
                data.sending_window_end || "18:00",
                JSON.stringify(data.sending_days || [1, 2, 3, 4, 5]),
                data.timezone || "UTC",
            ]
        );
        return this.findById(result.insertId, orgId);
    },

    async updateById(id, data, orgId = 1) {
        const fields = [];
        const params = [];

        if (data.name !== undefined) {
            fields.push("name = ?");
            params.push(String(data.name));
        }
        if (data.description !== undefined) {
            fields.push("description = ?");
            params.push(data.description);
        }
        if (data.is_active !== undefined) {
            fields.push("is_active = ?");
            params.push(data.is_active ? 1 : 0);
        }
        if (data.steps_config !== undefined) {
            fields.push("steps_config = ?");
            params.push(JSON.stringify(data.steps_config));
        }
        if (data.sending_window_start !== undefined) {
            fields.push("sending_window_start = ?");
            params.push(data.sending_window_start);
        }
        if (data.sending_window_end !== undefined) {
            fields.push("sending_window_end = ?");
            params.push(data.sending_window_end);
        }
        if (data.sending_days !== undefined) {
            fields.push("sending_days = ?");
            params.push(JSON.stringify(data.sending_days));
        }
        if (data.timezone !== undefined) {
            fields.push("timezone = ?");
            params.push(data.timezone);
        }

        if (fields.length === 0) return this.findById(id, orgId);

        params.push(Number(id), Number(orgId));
        await execute(
            `UPDATE ${table} SET ${fields.join(", ")} WHERE id = ? AND organization_id = ?`,
            params
        );
        return this.findById(id, orgId);
    },

    async deleteById(id, orgId = 1) {
        const result = await execute(
            `DELETE FROM ${table} WHERE id = ? AND organization_id = ?`,
            [Number(id), Number(orgId)]
        );
        return result.affectedRows > 0;
    },
};

import { execute, query } from "../config/db.js";
import { aseExecutionSchema } from "../schema/ase-execution.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = aseExecutionSchema;

export const AseExecution = {
    async findByKey(orgId, idempotencyKey) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
            [Number(orgId), String(idempotencyKey)]
        );
        return mapRow(rows[0]);
    },

    async claim({ organization_id, lead_id, idempotency_key, action_type, payload = null }) {
        try {
            const result = await execute(
                `INSERT INTO ${table} (organization_id, lead_id, idempotency_key, action_type, status, payload)
                 VALUES (?, ?, ?, ?, 'PROCESSING', ?)`,
                [
                    Number(organization_id),
                    Number(lead_id),
                    String(idempotency_key),
                    action_type,
                    payload ? JSON.stringify(payload) : null,
                ]
            );
            return { claimed: true, executionId: result.insertId };
        } catch (err) {
            if (err.code === "ER_DUP_ENTRY") {
                const existing = await this.findByKey(organization_id, idempotency_key);
                return { claimed: false, existing };
            }
            throw err;
        }
    },

    async complete(id, status = "SUCCEEDED", payload = null) {
        await execute(
            `UPDATE ${table} SET status = ?, payload = ? WHERE id = ?`,
            [status, payload ? JSON.stringify(payload) : null, Number(id)]
        );
    },
};

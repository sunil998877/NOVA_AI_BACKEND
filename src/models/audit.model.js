import { execute } from "../config/db.js";
import { auditSchema } from "../schema/audit.schema.js";

const { table } = auditSchema;

export const AuditLog = {
    async create(data) {
        await execute(
            `INSERT INTO ${table} (user_id, action, resource_id, ip_address) VALUES (?, ?, ?, ?)`,
            [
                data.user_id,
                data.action,
                data.resource_id ?? null,
                data.ip_address || "unknown",
            ]
        );
    },
};

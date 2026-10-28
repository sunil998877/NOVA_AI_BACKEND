import { execute, query } from "../config/db.js";
import { APPROVAL_STATUSES, aseApprovalSchema } from "../schema/ase-approval.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = aseApprovalSchema;

const parseJson = (value, fallback = null) => {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const toApproval = (row) => {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.payload = parseJson(row.payload, null);
    return mapped;
};

export const AseApproval = {
    async findById(orgId, id) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND id = ? LIMIT 1`,
            [Number(orgId), Number(id)]
        );
        return rows[0] ? toApproval(rows[0]) : null;
    },

    async findPending(orgId, leadId, actionType) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ? AND lead_id = ? AND action_type = ? AND status = ?
             LIMIT 1`,
            [Number(orgId), Number(leadId), String(actionType).toUpperCase(), APPROVAL_STATUSES.PENDING]
        );
        return rows[0] ? toApproval(rows[0]) : null;
    },

    async findLatestForLead(orgId, leadId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ? AND lead_id = ?
             ORDER BY (status = 'PENDING') DESC, requested_at DESC
             LIMIT 1`,
            [Number(orgId), Number(leadId)]
        );
        return rows[0] ? toApproval(rows[0]) : null;
    },

    async list(orgId, { status = APPROVAL_STATUSES.PENDING, leadId = null, limit = 50 } = {}) {
        const where = ["organization_id = ?"];
        const params = [Number(orgId)];
        if (status) {
            where.push("status = ?");
            params.push(String(status).toUpperCase());
        }
        if (leadId) {
            where.push("lead_id = ?");
            params.push(Number(leadId));
        }
        params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE ${where.join(" AND ")}
             ORDER BY requested_at ASC
             LIMIT ?`,
            params
        );
        return rows.map(toApproval);
    },

    async createPending({ organization_id, lead_id, action_type, payload = null }) {
        const existing = await this.findPending(organization_id, lead_id, action_type);
        if (existing) return { created: false, approval: existing };

        try {
            const result = await execute(
                `INSERT INTO ${table} (organization_id, lead_id, action_type, status, payload)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    Number(organization_id),
                    Number(lead_id),
                    String(action_type).toUpperCase(),
                    APPROVAL_STATUSES.PENDING,
                    payload ? JSON.stringify(payload) : null,
                ]
            );
            const row = await this.findById(organization_id, result.insertId);
            return { created: true, approval: row };
        } catch (err) {
            if (err.code === "ER_DUP_ENTRY" || err.errno === 1062) {
                const approval = await this.findPending(organization_id, lead_id, action_type);
                return { created: false, approval };
            }
            throw err;
        }
    },

    async review(orgId, id, { status, reviewedBy = null, payload = null }) {
        const next = String(status || "").toUpperCase();
        if (!Object.values(APPROVAL_STATUSES).includes(next) || next === APPROVAL_STATUSES.PENDING) {
            throw new Error(`Invalid approval review status: ${status}`);
        }
        const existing = await this.findById(orgId, id);
        if (!existing) return null;
        const merged = payload
            ? { ...(existing.payload || {}), ...payload }
            : existing.payload;
        await execute(
            `UPDATE ${table}
             SET status = ?, reviewed_by = ?, reviewed_at = ?, payload = ?
             WHERE organization_id = ? AND id = ?`,
            [
                next,
                reviewedBy ? Number(reviewedBy) : null,
                new Date(),
                merged ? JSON.stringify(merged) : null,
                Number(orgId),
                Number(id),
            ]
        );
        return this.findById(orgId, id);
    },

    async cancelPendingForLead(orgId, leadId, reason = "Cancelled") {
        const result = await execute(
            `UPDATE ${table}
             SET status = 'REJECTED', reviewed_at = ?, payload = ?
             WHERE organization_id = ? AND lead_id = ? AND status = 'PENDING'`,
            [new Date(), JSON.stringify({ reason }), Number(orgId), Number(leadId)]
        );
        return Number(result?.affectedRows || 0);
    },
};

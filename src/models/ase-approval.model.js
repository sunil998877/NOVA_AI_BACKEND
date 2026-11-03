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
        const where = ["a.organization_id = ?"];
        const params = [Number(orgId)];
        if (status && String(status).toUpperCase() !== "ALL") {
            const statuses = String(status)
                .split(",")
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean);
            if (statuses.length === 1) {
                where.push("a.status = ?");
                params.push(statuses[0]);
            } else if (statuses.length > 1) {
                where.push(`a.status IN (${statuses.map(() => "?").join(",")})`);
                params.push(...statuses);
            }
        }
        if (leadId) {
            where.push("a.lead_id = ?");
            params.push(Number(leadId));
        }
        params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
        const rows = await query(
            `SELECT a.id, a.organization_id, a.lead_id, a.action_type, a.status, a.payload,
                    a.requested_at, a.reviewed_by, a.reviewed_at, a.created_at, a.updated_at,
                    l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                    l.phone AS lead_phone, l.priority AS lead_priority, l.status AS lead_status,
                    l.next_action AS lead_next_action, l.next_action_time AS lead_next_action_time,
                    l.metadata AS lead_metadata
             FROM ${table} a
             LEFT JOIN leads l ON l.id = a.lead_id AND l.organization_id = a.organization_id
             WHERE ${where.join(" AND ")}
             ORDER BY (a.status = 'PENDING') DESC, a.requested_at ASC
             LIMIT ?`,
            params
        );
        return rows.map((row) => {
            const approval = toApproval(row);
            if (!approval) return null;
            const meta =
                typeof row.lead_metadata === "string"
                    ? parseJson(row.lead_metadata, {})
                    : row.lead_metadata && typeof row.lead_metadata === "object"
                      ? row.lead_metadata
                      : {};
            const email = meta?.outreach_email || null;
            approval.lead = {
                id: approval.lead_id,
                name: row.lead_name || null,
                email: row.lead_email || null,
                company: row.lead_company || null,
                phone: row.lead_phone || null,
                priority: row.lead_priority != null ? Number(row.lead_priority) : null,
                status: row.lead_status || null,
                next_action: row.lead_next_action || null,
                next_action_time: row.lead_next_action_time || null,
            };
            approval.draft = email
                ? {
                      subject: email.subject || null,
                      preview: String(email.text || "").slice(0, 280),
                      generation_status: email.generation_status || null,
                      quality_score: email.quality_score ?? null,
                      approvalStatus: email.approvalStatus || null,
                  }
                : null;
            delete approval.lead_metadata;
            return approval;
        }).filter(Boolean);
    },

    async countByStatus(orgId) {
        const rows = await query(
            `SELECT status, COUNT(*) AS total
             FROM ${table}
             WHERE organization_id = ?
             GROUP BY status`,
            [Number(orgId)]
        );
        const counts = Object.fromEntries(
            Object.values(APPROVAL_STATUSES).map((status) => [status, 0])
        );
        for (const row of rows) {
            counts[String(row.status).toUpperCase()] = Number(row.total || 0);
        }
        return counts;
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

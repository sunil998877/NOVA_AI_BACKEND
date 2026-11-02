import { execute, query } from "../config/db.js";
import { emailReplyDraftSchema } from "../schema/inbound-email.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = emailReplyDraftSchema;

const JSON_FIELDS = ["grounding", "guard_issues"];
const WRITABLE = new Set([
    "subject",
    "body_text",
    "body_html",
    "review_reason",
    "edited",
    "edited_by",
    "edited_at",
    "reviewed_by",
    "reviewed_at",
    "reject_reason",
    "send_attempts",
    "sent_message_id",
    "sent_at",
    "send_error",
    "guard_issues",
]);

const parseJson = (value, fallback = null) => {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const toDraft = (row) => {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.grounding = parseJson(row.grounding, {});
    mapped.guard_issues = parseJson(row.guard_issues, []);
    mapped.edited = Boolean(row.edited);
    return mapped;
};

function serialize(field, value) {
    if (JSON_FIELDS.includes(field)) return value == null ? null : JSON.stringify(value);
    if (field === "edited") return value ? 1 : 0;
    return value;
}

export const EmailReplyDraft = {
    async findById(orgId, id) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND id = ? LIMIT 1`,
            [Number(orgId), Number(id)]
        );
        return toDraft(rows[0]);
    },

    async findByInbound(orgId, inboundEmailId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND inbound_email_id = ? LIMIT 1`,
            [Number(orgId), Number(inboundEmailId)]
        );
        return toDraft(rows[0]);
    },

    async list(orgId, { statuses = null, leadId = null, limit = 50, offset = 0 } = {}) {
        const where = ["d.organization_id = ?"];
        const params = [Number(orgId)];
        if (statuses?.length) {
            where.push(`d.status IN (${statuses.map(() => "?").join(", ")})`);
            params.push(...statuses);
        }
        if (leadId) {
            where.push("d.lead_id = ?");
            params.push(Number(leadId));
        }
        params.push(Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0));
        const rows = await query(
            `SELECT d.*, l.name AS lead_name, l.email AS lead_email, l.company AS lead_company,
                    i.subject AS inbound_subject, i.body_text AS inbound_body, i.received_at AS inbound_received_at,
                    i.from_email AS inbound_from, i.review_flags AS inbound_review_flags
             FROM ${table} d
             LEFT JOIN leads l ON l.id = d.lead_id AND l.organization_id = d.organization_id
             LEFT JOIN inbound_emails i ON i.id = d.inbound_email_id AND i.organization_id = d.organization_id
             WHERE ${where.join(" AND ")}
             ORDER BY d.created_at DESC, d.id DESC
             LIMIT ? OFFSET ?`,
            params
        );
        return rows.map((row) => ({ ...toDraft(row), inbound_review_flags: parseJson(row.inbound_review_flags, []) }));
    },

    async countByStatus(orgId) {
        const rows = await query(
            `SELECT status, COUNT(*) AS total FROM ${table} WHERE organization_id = ? GROUP BY status`,
            [Number(orgId)]
        );
        return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
    },

    /** One draft per inbound message; a duplicate webhook returns the existing draft with created=false. */
    async createOnce(data) {
        const orgId = Number(data.organization_id);
        try {
            const result = await execute(
                `INSERT INTO ${table}
                 (organization_id, lead_id, inbound_email_id, intent, status, subject, body_text, body_html,
                  generated_subject, generated_body_text, generation_method, grounding, guard_issues, review_reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    orgId,
                    Number(data.lead_id),
                    Number(data.inbound_email_id),
                    data.intent,
                    data.status,
                    data.subject || null,
                    data.body_text || null,
                    data.body_html || null,
                    data.subject || null,
                    data.body_text || null,
                    data.generation_method || null,
                    JSON.stringify(data.grounding || {}),
                    JSON.stringify(data.guard_issues || []),
                    data.review_reason ? String(data.review_reason).slice(0, 500) : null,
                ]
            );
            return { created: true, draft: await this.findById(orgId, result.insertId) };
        } catch (error) {
            if (error.code === "ER_DUP_ENTRY" || error.errno === 1062) {
                return { created: false, draft: await this.findByInbound(orgId, data.inbound_email_id) };
            }
            throw error;
        }
    },

    /** Compare-and-set status change; returns null when the draft is no longer in one of `fromStatuses`. */
    async transition(orgId, id, fromStatuses, toStatus, fields = {}) {
        const sets = ["status = ?"];
        const params = [toStatus];
        for (const [field, value] of Object.entries(fields)) {
            if (!WRITABLE.has(field)) continue;
            sets.push(`${field} = ?`);
            params.push(serialize(field, value));
        }
        params.push(Number(orgId), Number(id), ...fromStatuses);
        const result = await execute(
            `UPDATE ${table} SET ${sets.join(", ")}
             WHERE organization_id = ? AND id = ? AND status IN (${fromStatuses.map(() => "?").join(", ")})`,
            params
        );
        if (!result?.affectedRows) return null;
        return this.findById(orgId, id);
    },

    async cancelOpenForLead(orgId, leadId, reason) {
        const result = await execute(
            `UPDATE ${table} SET status = 'CANCELLED', reject_reason = ?
             WHERE organization_id = ? AND lead_id = ? AND status IN ('PENDING_APPROVAL', 'NEEDS_HUMAN_REVIEW', 'APPROVED')`,
            [String(reason || "Cancelled").slice(0, 500), Number(orgId), Number(leadId)]
        );
        return Number(result?.affectedRows || 0);
    },
};

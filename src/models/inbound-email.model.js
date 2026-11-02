import { execute, query } from "../config/db.js";
import { inboundEmailSchema } from "../schema/inbound-email.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = inboundEmailSchema;

const parseJson = (value, fallback = null) => {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const toInbound = (row) => {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.references_json = parseJson(row.references_json, []);
    mapped.review_flags = parseJson(row.review_flags, []);
    return mapped;
};

export const InboundEmail = {
    async findById(orgId, id) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND id = ? LIMIT 1`,
            [Number(orgId), Number(id)]
        );
        return toInbound(rows[0]);
    },

    async findByMessageId(orgId, messageId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND message_id = ? LIMIT 1`,
            [Number(orgId), String(messageId)]
        );
        return toInbound(rows[0]);
    },

    async listForLead(orgId, leadId, limit = 20) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ? AND lead_id = ?
             ORDER BY received_at DESC, id DESC LIMIT ?`,
            [Number(orgId), Number(leadId), Math.min(Math.max(Number(limit) || 20, 1), 100)]
        );
        return rows.map(toInbound);
    },

    /** Inserts once per (organization, message id); a webhook retry returns the stored row with created=false. */
    async recordOnce(data) {
        const orgId = Number(data.organization_id);
        try {
            const result = await execute(
                `INSERT INTO ${table}
                 (organization_id, lead_id, enrollment_id, campaign_id, message_id, in_reply_to, references_json,
                  from_email, to_email, subject, body_text, received_at, matched_by, intent, intent_confidence,
                  intent_method, route, review_flags, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    orgId,
                    Number(data.lead_id),
                    data.enrollment_id ? Number(data.enrollment_id) : null,
                    data.campaign_id ? Number(data.campaign_id) : null,
                    String(data.message_id).slice(0, 255),
                    data.in_reply_to ? String(data.in_reply_to).slice(0, 255) : null,
                    JSON.stringify(data.references || []),
                    String(data.from_email || "").slice(0, 255),
                    data.to_email ? String(data.to_email).slice(0, 255) : null,
                    data.subject ? String(data.subject).slice(0, 500) : null,
                    data.body_text || null,
                    data.received_at ? new Date(data.received_at) : new Date(),
                    data.matched_by || null,
                    data.intent || "OTHER",
                    data.intent_confidence ?? null,
                    data.intent_method || null,
                    data.route || "HUMAN_REVIEW",
                    JSON.stringify(data.review_flags || []),
                    data.status || "RECEIVED",
                ]
            );
            return { created: true, inbound: await this.findById(orgId, result.insertId) };
        } catch (error) {
            if (error.code === "ER_DUP_ENTRY" || error.errno === 1062) {
                return { created: false, inbound: await this.findByMessageId(orgId, data.message_id) };
            }
            throw error;
        }
    },

    async updateStatus(orgId, id, status) {
        await execute(`UPDATE ${table} SET status = ? WHERE organization_id = ? AND id = ?`, [
            String(status),
            Number(orgId),
            Number(id),
        ]);
    },
};

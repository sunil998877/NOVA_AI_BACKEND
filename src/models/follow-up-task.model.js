import { execute, query } from "../config/db.js";
import { followUpTaskSchema } from "../schema/follow-up.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = followUpTaskSchema;

function parseJson(val, fallback) {
    if (!val) return fallback;
    if (typeof val === "object") return val;
    try {
        return JSON.parse(val);
    } catch {
        return fallback;
    }
}

function mapTask(row) {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.video_concept = parseJson(row.video_concept, null);
    return mapped;
}

export const FollowUpTask = {
    async findById(id, orgId = 1) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE id = ? AND organization_id = ? LIMIT 1`,
            [Number(id), Number(orgId)]
        );
        return mapTask(rows[0]);
    },

    async findByEnrollmentId(enrollmentId, orgId = 1) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE enrollment_id = ? AND organization_id = ?
             ORDER BY step_number ASC`,
            [Number(enrollmentId), Number(orgId)]
        );
        return rows.map(mapTask);
    },

    async findByLeadId(leadId, orgId = 1) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE lead_id = ? AND organization_id = ?
             ORDER BY step_number ASC`,
            [Number(leadId), Number(orgId)]
        );
        return rows.map(mapTask);
    },

    async findDueTasks(orgId = null, limit = 20, now = new Date()) {
        const where = ["status = 'SCHEDULED'", "scheduled_at <= ?"];
        const params = [now];

        if (orgId) {
            where.push("organization_id = ?");
            params.push(Number(orgId));
        }

        params.push(Number(limit));
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE ${where.join(" AND ")}
             ORDER BY scheduled_at ASC
             LIMIT ?`,
            params
        );
        return rows.map(mapTask);
    },

    async claimForProcessing(id, orgId = 1) {
        const result = await execute(
            `UPDATE ${table} SET status = 'PROCESSING'
             WHERE id = ? AND organization_id = ? AND status = 'SCHEDULED'`,
            [Number(id), Number(orgId)]
        );
        return result.affectedRows > 0;
    },

    async create(data) {
        const orgId = Number(data.organization_id || 1);
        const result = await execute(
            `INSERT INTO ${table} (
                organization_id, enrollment_id, lead_id, sequence_id,
                step_number, day_offset, scheduled_at, status, thread_mode,
                in_reply_to, subject, body_text, body_html, video_concept
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orgId,
                Number(data.enrollment_id),
                Number(data.lead_id),
                Number(data.sequence_id),
                Number(data.step_number),
                Number(data.day_offset),
                new Date(data.scheduled_at),
                data.status || "SCHEDULED",
                data.thread_mode || "REPLY_THREAD",
                data.in_reply_to || null,
                data.subject || null,
                data.body_text || null,
                data.body_html || null,
                data.video_concept ? JSON.stringify(data.video_concept) : null,
            ]
        );
        return this.findById(result.insertId, orgId);
    },

    async updateById(id, data, orgId = 1) {
        const fields = [];
        const params = [];

        if (data.status !== undefined) {
            fields.push("status = ?");
            params.push(data.status);
        }
        if (data.scheduled_at !== undefined) {
            fields.push("scheduled_at = ?");
            params.push(new Date(data.scheduled_at));
        }
        if (data.subject !== undefined) {
            fields.push("subject = ?");
            params.push(data.subject);
        }
        if (data.body_text !== undefined) {
            fields.push("body_text = ?");
            params.push(data.body_text);
        }
        if (data.body_html !== undefined) {
            fields.push("body_html = ?");
            params.push(data.body_html);
        }
        if (data.video_concept !== undefined) {
            fields.push("video_concept = ?");
            params.push(data.video_concept ? JSON.stringify(data.video_concept) : null);
        }
        if (data.sent_at !== undefined) {
            fields.push("sent_at = ?");
            params.push(data.sent_at ? new Date(data.sent_at) : null);
        }
        if (data.last_error !== undefined) {
            fields.push("last_error = ?");
            params.push(data.last_error);
        }
        if (data.retry_count !== undefined) {
            fields.push("retry_count = ?");
            params.push(Number(data.retry_count));
        }
        if (data.mail_id !== undefined) {
            fields.push("mail_id = ?");
            params.push(data.mail_id ? Number(data.mail_id) : null);
        }
        if (data.message_id !== undefined) {
            fields.push("message_id = ?");
            params.push(data.message_id);
        }

        if (fields.length === 0) return this.findById(id, orgId);

        params.push(Number(id), Number(orgId));
        await execute(
            `UPDATE ${table} SET ${fields.join(", ")} WHERE id = ? AND organization_id = ?`,
            params
        );
        return this.findById(id, orgId);
    },

    async cancelRemaining(enrollmentId, reason = "Cancelled", newStatus = "CANCELLED", orgId = 1) {
        await execute(
            `UPDATE ${table} SET status = ?, last_error = ?
             WHERE enrollment_id = ? AND organization_id = ? AND status IN ('SCHEDULED', 'PROCESSING')`,
            [newStatus, reason, Number(enrollmentId), Number(orgId)]
        );
    },

    async blockRemainingForReply(enrollmentId, reason = "Prospect replied to outreach", orgId = 1) {
        return this.cancelRemaining(enrollmentId, reason, "BLOCKED_REPLY", orgId);
    },

    async findByMessageId(messageId, orgId = null) {
        if (!messageId) return null;
        const cleanId = String(messageId).replace(/[<>]/g, "").trim();
        const sql = orgId
            ? `SELECT ${columns} FROM ${table}
               WHERE (message_id = ? OR message_id LIKE ? OR in_reply_to = ? OR in_reply_to LIKE ?)
                 AND organization_id = ?
               LIMIT 1`
            : `SELECT ${columns} FROM ${table}
               WHERE (message_id = ? OR message_id LIKE ? OR in_reply_to = ? OR in_reply_to LIKE ?)
               LIMIT 1`;
        const params = orgId
            ? [cleanId, `%${cleanId}%`, cleanId, `%${cleanId}%`, Number(orgId)]
            : [cleanId, `%${cleanId}%`, cleanId, `%${cleanId}%`];
        const rows = await query(sql, params);
        return mapRow(rows[0]);
    },

    async listBlocked(orgId = 1, { limit = 50, offset = 0 } = {}) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ? AND status IN ('BLOCKED_REPLY', 'CANCELLED', 'SKIPPED', 'FAILED')
             ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
            [Number(orgId), Number(limit), Number(offset)]
        );
        return rows.map(mapRow);
    },
};

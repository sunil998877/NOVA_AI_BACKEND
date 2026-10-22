import { execute, query } from "../config/db.js";
import { followUpEnrollmentSchema } from "../schema/follow-up.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = followUpEnrollmentSchema;

const TERMINAL_STATES = new Set([
    "stopped_meeting_booked",
    "stopped_unsubscribed",
    "stopped_do_not_contact",
    "completed",
    "CANCELLED",
    "MEETING_BOOKED",
    "COMPLETED",
]);

export const FollowUpEnrollment = {
    async findById(id, orgId = null) {
        const sql = orgId
            ? `SELECT ${columns} FROM ${table} WHERE id = ? AND organization_id = ? LIMIT 1`
            : `SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`;
        const params = orgId ? [Number(id), Number(orgId)] : [Number(id)];
        const rows = await query(sql, params);
        return mapRow(rows[0]);
    },

    async findActiveByLeadId(leadId, orgId = 1) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE lead_id = ? AND organization_id = ? AND (status = 'ACTIVE' OR status = 'active')
             ORDER BY id DESC LIMIT 1`,
            [Number(leadId), Number(orgId)]
        );
        return mapRow(rows[0]);
    },

    async findByLeadId(leadId, orgId = 1) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE lead_id = ? AND organization_id = ?
             ORDER BY id DESC`,
            [Number(leadId), Number(orgId)]
        );
        return rows.map(mapRow);
    },

    async list(orgId = 1, { status = null, limit = 50, offset = 0 } = {}) {
        const where = ["organization_id = ?"];
        const params = [Number(orgId)];

        if (status) {
            where.push("status = ?");
            params.push(status);
        }

        params.push(Number(limit), Number(offset));
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE ${where.join(" AND ")}
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            params
        );
        return rows.map(mapRow);
    },

    async countByStatus(orgId = 1) {
        const rows = await query(
            `SELECT status, COUNT(*) AS count FROM ${table} WHERE organization_id = ? GROUP BY status`,
            [Number(orgId)]
        );
        const map = {};
        for (const r of rows) {
            map[r.status] = Number(r.count || 0);
        }
        return map;
    },

    async create(data) {
        const orgId = Number(data.organization_id || 1);
        const result = await execute(
            `INSERT INTO ${table} (
                organization_id, sequence_id, lead_id, campaign_id,
                initial_mail_id, initial_message_id, initial_subject,
                initial_sent_at, current_step, total_steps, status,
                paused_reason, reply_message_id, reply_subject, reply_outcome,
                reply_received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orgId,
                Number(data.sequence_id),
                Number(data.lead_id),
                data.campaign_id ? Number(data.campaign_id) : null,
                data.initial_mail_id ? Number(data.initial_mail_id) : null,
                data.initial_message_id || null,
                data.initial_subject || null,
                data.initial_sent_at ? new Date(data.initial_sent_at) : new Date(),
                Number(data.current_step || 1),
                Number(data.total_steps || 5),
                data.status || "active",
                data.paused_reason || null,
                data.reply_message_id || null,
                data.reply_subject || null,
                data.reply_outcome || null,
                data.reply_received_at ? new Date(data.reply_received_at) : null,
            ]
        );
        return this.findById(result.insertId, orgId);
    },

    async updateById(id, data, orgId = 1) {
        const existing = await this.findById(id, orgId);
        if (!existing) return null;

        if (TERMINAL_STATES.has(existing.status) && data.status && !TERMINAL_STATES.has(data.status) && !data.forceTerminalOverride) {
            return existing;
        }

        const fields = [];
        const params = [];

        if (data.current_step !== undefined) {
            fields.push("current_step = ?");
            params.push(Number(data.current_step));
        }
        if (data.status !== undefined) {
            fields.push("status = ?");
            params.push(data.status);
        }
        if (data.paused_reason !== undefined) {
            fields.push("paused_reason = ?");
            params.push(data.paused_reason);
        }
        if (data.completed_at !== undefined) {
            fields.push("completed_at = ?");
            params.push(data.completed_at ? new Date(data.completed_at) : null);
        }
        if (data.reply_message_id !== undefined) {
            fields.push("reply_message_id = ?");
            params.push(data.reply_message_id);
        }
        if (data.reply_subject !== undefined) {
            fields.push("reply_subject = ?");
            params.push(data.reply_subject);
        }
        if (data.reply_outcome !== undefined) {
            fields.push("reply_outcome = ?");
            params.push(data.reply_outcome);
        }
        if (data.reply_received_at !== undefined) {
            fields.push("reply_received_at = ?");
            params.push(data.reply_received_at ? new Date(data.reply_received_at) : null);
        }
        if (data.reply_processed_at !== undefined) {
            fields.push("reply_processed_at = ?");
            params.push(data.reply_processed_at ? new Date(data.reply_processed_at) : null);
        }
        if (data.reply_processed_by !== undefined) {
            fields.push("reply_processed_by = ?");
            params.push(data.reply_processed_by);
        }
        if (data.resumed_at !== undefined) {
            fields.push("resumed_at = ?");
            params.push(data.resumed_at ? new Date(data.resumed_at) : null);
        }
        if (data.resumed_by !== undefined) {
            fields.push("resumed_by = ?");
            params.push(data.resumed_by);
        }
        if (data.resumed_reason !== undefined) {
            fields.push("resumed_reason = ?");
            params.push(data.resumed_reason);
        }

        if (fields.length === 0) return existing;

        params.push(Number(id), Number(orgId));
        await execute(
            `UPDATE ${table} SET ${fields.join(", ")} WHERE id = ? AND organization_id = ?`,
            params
        );
        return this.findById(id, orgId);
    },

    async pause(id, reason = "Manually paused", orgId = 1) {
        return this.updateById(id, { status: "paused_manual", paused_reason: reason }, orgId);
    },

    async resume(id, orgId = 1, metadata = {}) {
        return this.updateById(
            id,
            {
                status: "active",
                paused_reason: null,
                resumed_at: new Date(),
                resumed_by: metadata.resumedBy || "user",
                resumed_reason: metadata.resumedReason || "Manual resume after review",
                forceTerminalOverride: Boolean(metadata.forceTerminalOverride),
            },
            orgId
        );
    },

    async markReplied(id, payload = {}, orgId = 1) {
        return this.updateById(
            id,
            {
                status: "paused_reply_received",
                paused_reason: "Prospect replied",
                reply_message_id: payload.messageId || null,
                reply_subject: payload.subject || null,
                reply_outcome: payload.outcome || null,
                reply_received_at: payload.date ? new Date(payload.date) : new Date(),
            },
            orgId
        );
    },

    async markOutOfOffice(id, payload = {}, orgId = 1) {
        return this.updateById(
            id,
            {
                status: "paused_out_of_office",
                paused_reason: "Out-of-office response detected",
                reply_message_id: payload.messageId || null,
                reply_subject: payload.subject || null,
                reply_outcome: "OUTCOME_OOO",
                reply_received_at: payload.date ? new Date(payload.date) : new Date(),
            },
            orgId
        );
    },

    async markMeetingBooked(id, orgId = 1) {
        return this.updateById(
            id,
            {
                status: "stopped_meeting_booked",
                paused_reason: "Sales meeting booked",
                completed_at: new Date(),
            },
            orgId
        );
    },

    async markUnsubscribed(id, reason = "Prospect opted out / unsubscribed", orgId = 1) {
        return this.updateById(
            id,
            {
                status: "stopped_unsubscribed",
                paused_reason: reason,
                completed_at: new Date(),
            },
            orgId
        );
    },

    async markDoNotContact(id, reason = "Compliance DNC applied", orgId = 1) {
        return this.updateById(
            id,
            {
                status: "stopped_do_not_contact",
                paused_reason: reason,
                completed_at: new Date(),
            },
            orgId
        );
    },

    async markCompleted(id, orgId = 1) {
        return this.updateById(
            id,
            {
                status: "completed",
                completed_at: new Date(),
            },
            orgId
        );
    },

    async markFailed(id, reason = "Execution failure", orgId = 1) {
        return this.updateById(
            id,
            {
                status: "failed",
                paused_reason: reason,
            },
            orgId
        );
    },

    async markReplyProcessed(id, user = {}, orgId = 1) {
        return this.updateById(
            id,
            {
                reply_processed_at: new Date(),
                reply_processed_by: user.email || user.name || "user",
            },
            orgId
        );
    },

    async cancel(id, reason = "Cancelled", orgId = 1) {
        return this.updateById(id, { status: "stopped_do_not_contact", paused_reason: reason, completed_at: new Date() }, orgId);
    },
};

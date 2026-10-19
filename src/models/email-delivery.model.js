import { execute, query } from "../config/db.js";
import { emailDeliverySchema } from "../schema/email-delivery.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns, updatable } = emailDeliverySchema;
const UPDATABLE = new Set(updatable);

export const EmailDelivery = {
    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [Number(id)]);
        return rows[0] ? mapRow(rows[0]) : null;
    },

    async findByIdempotencyKey(key) {
        if (!key) return null;
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE idempotency_key = ? LIMIT 1`, [String(key)]);
        return rows[0] ? mapRow(rows[0]) : null;
    },

    async findByCampaign(campaignId, { status = "", limit = 50, skip = 0 } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const safeSkip = Math.max(Number(skip) || 0, 0);
        let sql = `SELECT ${columns} FROM ${table} WHERE campaign_id = ?`;
        const params = [Number(campaignId)];
        if (status) {
            sql += ` AND status = ?`;
            params.push(status);
        }
        sql += ` ORDER BY id ASC LIMIT ${safeLimit} OFFSET ${safeSkip}`;
        const rows = await query(sql, params);
        return rows.map(mapRow);
    },

    async create(data) {
        const existing = await this.findByIdempotencyKey(data.idempotency_key);
        if (existing) {
            return existing;
        }

        const orgId = Number(data.organization_id || 1);
        const campaignId = data.campaign_id ? Number(data.campaign_id) : null;
        const mailId = data.mail_id ? Number(data.mail_id) : null;
        const leadId = data.lead_id ? Number(data.lead_id) : null;
        const senderAccountId = data.sender_account_id ? Number(data.sender_account_id) : null;

        const result = await execute(
            `INSERT INTO ${table} (
                organization_id, campaign_id, mail_id, lead_id, sender_account_id,
                recipient_email, recipient_name, subject, body_html, body_text,
                idempotency_key, status, skip_reason, scheduled_at, max_attempts,
                headers, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orgId,
                campaignId,
                mailId,
                leadId,
                senderAccountId,
                String(data.recipient_email).toLowerCase().trim(),
                data.recipient_name || null,
                data.subject || null,
                data.body_html || null,
                data.body_text || null,
                data.idempotency_key,
                data.status || "pending",
                data.skip_reason || null,
                data.scheduled_at ? new Date(data.scheduled_at) : null,
                Number(data.max_attempts) || 3,
                data.headers ? JSON.stringify(data.headers) : null,
                data.metadata ? JSON.stringify(data.metadata) : null,
            ]
        );

        return this.findById(result.insertId);
    },

    async reserveNextPending(campaignId, workerId) {
        const selectRows = await query(
            `SELECT id FROM ${table}
             WHERE campaign_id = ?
               AND status IN ('pending', 'scheduled', 'retry_wait')
               AND (scheduled_at IS NULL OR scheduled_at <= NOW())
               AND (locked_at IS NULL OR locked_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
             ORDER BY id ASC LIMIT 1`,
            [Number(campaignId)]
        );

        if (!selectRows || selectRows.length === 0) return null;
        const targetId = selectRows[0].id;

        const updateResult = await execute(
            `UPDATE ${table}
             SET status = 'reserved', locked_at = NOW(), locked_by = ?
             WHERE id = ? AND status IN ('pending', 'scheduled', 'retry_wait')`,
            [String(workerId), Number(targetId)]
        );

        if (updateResult.affectedRows === 0) return null;
        return this.findById(targetId);
    },

    async markSending(id, senderAccountId = null) {
        await execute(
            `UPDATE ${table}
             SET status = 'sending',
                 sender_account_id = COALESCE(?, sender_account_id),
                 attempts_count = attempts_count + 1
             WHERE id = ?`,
            [senderAccountId ? Number(senderAccountId) : null, Number(id)]
        );
        return this.findById(id);
    },

    async markSent(id, { messageId = null, deliveryMethod = "smtp", senderAccountId = null } = {}) {
        await execute(
            `UPDATE ${table}
             SET status = 'sent',
                 message_id = ?,
                 delivery_method = ?,
                 sender_account_id = COALESCE(?, sender_account_id),
                 sent_at = NOW(),
                 locked_at = NULL,
                 locked_by = NULL
             WHERE id = ?`,
            [messageId, deliveryMethod, senderAccountId ? Number(senderAccountId) : null, Number(id)]
        );
        return this.findById(id);
    },

    async markFailed(id, { error = "", retryable = false, retryAfterSeconds = 60 } = {}) {
        const item = await this.findById(id);
        const currentAttempts = (item?.attempts_count || 1);
        const maxAttempts = (item?.max_attempts || 3);
        const shouldRetry = retryable && currentAttempts < maxAttempts;

        if (shouldRetry) {
            const retryAt = new Date(Date.now() + retryAfterSeconds * 1000);
            await execute(
                `UPDATE ${table}
                 SET status = 'retry_wait',
                     last_error = ?,
                     retry_after = ?,
                     scheduled_at = ?,
                     locked_at = NULL,
                     locked_by = NULL
                 WHERE id = ?`,
                [String(error).slice(0, 1000), retryAt, retryAt, Number(id)]
            );
        } else {
            await execute(
                `UPDATE ${table}
                 SET status = 'failed',
                     last_error = ?,
                     locked_at = NULL,
                     locked_by = NULL
                 WHERE id = ?`,
                [String(error).slice(0, 1000), Number(id)]
            );
        }

        return this.findById(id);
    },

    async markUnknown(id, { error = "Ambiguous provider response" } = {}) {
        await execute(
            `UPDATE ${table}
             SET status = 'unknown',
                 last_error = ?,
                 locked_at = NULL,
                 locked_by = NULL
             WHERE id = ?`,
            [String(error).slice(0, 1000), Number(id)]
        );
        return this.findById(id);
    },

    async markSkipped(id, { reason = "SUPPRESSED" } = {}) {
        await execute(
            `UPDATE ${table}
             SET status = 'skipped',
                 skip_reason = ?,
                 locked_at = NULL,
                 locked_by = NULL
             WHERE id = ?`,
            [String(reason).slice(0, 128), Number(id)]
        );
        return this.findById(id);
    },

    async getStatsByCampaign(campaignId) {
        const rows = await query(
            `SELECT
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
                COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END), 0) AS scheduled,
                COALESCE(SUM(CASE WHEN status = 'reserved' OR status = 'sending' THEN 1 ELSE 0 END), 0) AS processing,
                COALESCE(SUM(CASE WHEN status = 'retry_wait' THEN 1 ELSE 0 END), 0) AS retry_wait,
                COALESCE(SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_status,
                COALESCE(SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped
             FROM ${table}
             WHERE campaign_id = ?`,
            [Number(campaignId)]
        );
        const r = rows[0] || {};
        return {
            total: Number(r.total || 0),
            sent: Number(r.sent || 0),
            failed: Number(r.failed || 0),
            pending: Number(r.pending || 0),
            scheduled: Number(r.scheduled || 0),
            processing: Number(r.processing || 0),
            retry_wait: Number(r.retry_wait || 0),
            unknown: Number(r.unknown_status || 0),
            skipped: Number(r.skipped || 0),
        };
    },

    async getSkippedReasons(campaignId) {
        const rows = await query(
            `SELECT skip_reason, COUNT(*) AS count
             FROM ${table}
             WHERE campaign_id = ? AND status = 'skipped'
             GROUP BY skip_reason`,
            [Number(campaignId)]
        );
        return Object.fromEntries(rows.map((r) => [r.skip_reason, Number(r.count)]));
    },
};

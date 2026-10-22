import { execute, query } from "../config/db.js";
import { telephonyWebhookEventSchema } from "../schema/telephony-webhook-event.schema.js";
import { mapRow } from "./mapRow.js";
import crypto from "crypto";

const { table, columns } = telephonyWebhookEventSchema;

export const TelephonyWebhookEvent = {
    generateFingerprint(provider, callUuid, eventType, payload = {}) {
        const pUuid = String(callUuid || payload.CallUUID || payload.CallId || payload.request_uuid || "").trim();
        const eType = String(eventType || payload.CallStatus || payload.Status || payload.Event || "").trim();
        const duration = String(payload.Duration || payload.call_duration || "").trim();
        const hangup = String(payload.HangupCause || payload.hangup_cause_name || "").trim();
        const answer = String(payload.AnswerTime || payload.answer_time || "").trim();
        const raw = `${provider}:${pUuid}:${eType}:${duration}:${hangup}:${answer}`;
        return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 48);
    },

    async recordEvent({ organization_id = 1, provider = "plivo", event_id = null, event_fingerprint, provider_call_uuid = null, call_id = null, event_type, payload = {} }) {
        const orgId = Number(organization_id || 1);
        const fp = event_fingerprint || this.generateFingerprint(provider, provider_call_uuid, event_type, payload);

        try {
            const existing = await query(
                `SELECT ${columns} FROM ${table} WHERE event_fingerprint = ? LIMIT 1`,
                [fp]
            );
            if (existing && existing.length > 0) {
                return { event: mapRow(existing[0]), isDuplicate: true };
            }

            const result = await execute(
                `INSERT INTO ${table} (organization_id, provider, event_id, event_fingerprint, provider_call_uuid, call_id, event_type, payload)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    orgId,
                    provider,
                    event_id || null,
                    fp,
                    provider_call_uuid || null,
                    call_id ? Number(call_id) : null,
                    event_type || "UNKNOWN",
                    payload ? JSON.stringify(payload) : null,
                ]
            );

            const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [result.insertId]);
            return { event: mapRow(rows[0]), isDuplicate: false };
        } catch (err) {
            if (err.message && (err.message.includes("Duplicate") || err.code === "ER_DUP_ENTRY")) {
                const rows = await query(`SELECT ${columns} FROM ${table} WHERE event_fingerprint = ? LIMIT 1`, [fp]);
                return { event: rows[0] ? mapRow(rows[0]) : null, isDuplicate: true };
            }
            throw err;
        }
    },

    async listByCallUuid(providerCallUuid) {
        if (!providerCallUuid) return [];
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE provider_call_uuid = ? ORDER BY created_at ASC`,
            [String(providerCallUuid)]
        );
        return rows.map(mapRow);
    },
};

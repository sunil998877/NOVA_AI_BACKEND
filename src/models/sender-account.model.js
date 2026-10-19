import nodemailer from "nodemailer";
import { execute, query } from "../config/db.js";
import { senderAccountSchema } from "../schema/sender-account.schema.js";
import { mapRow } from "./mapRow.js";
import { encryptSecret, decryptSecret } from "../services/email/secretCipher.js";
import { env } from "../config/env.js";

const { table, columns, updatable } = senderAccountSchema;
const UPDATABLE = new Set(updatable);

function sanitizeAccount(row) {
    if (!row) return null;
    const mapped = mapRow(row);
    if (!mapped) return null;
    delete mapped.password_encrypted;
    mapped.has_credentials = true;
    mapped.current_day_sends = Number(mapped.current_day_sends || 0);
    mapped.daily_limit = Number(mapped.daily_limit || 200);
    mapped.hourly_limit = Number(mapped.hourly_limit || 50);
    mapped.remaining_daily = Math.max(0, mapped.daily_limit - mapped.current_day_sends);
    return mapped;
}

function getTodayString() {
    return new Date().toISOString().slice(0, 10);
}

function getHourString() {
    return new Date().toISOString().slice(0, 13);
}

export const SenderAccount = {
    sanitize: sanitizeAccount,

    async findById(id, orgId = null) {
        let sql = `SELECT ${columns} FROM ${table} WHERE id = ?`;
        const params = [Number(id)];
        if (orgId !== null && orgId !== undefined) {
            sql += ` AND organization_id = ?`;
            params.push(Number(orgId));
        }
        sql += ` LIMIT 1`;
        const rows = await query(sql, params);
        return rows[0] ? mapRow(rows[0]) : null;
    },

    async findSafeById(id, orgId = null) {
        const raw = await this.findById(id, orgId);
        return sanitizeAccount(raw);
    },

    async listByOrg(orgId, { status = "" } = {}) {
        let sql = `SELECT ${columns} FROM ${table} WHERE organization_id = ?`;
        const params = [Number(orgId)];
        if (status) {
            sql += ` AND status = ?`;
            params.push(status);
        }
        sql += ` ORDER BY current_day_sends ASC, last_used_at ASC, id ASC`;
        const rows = await query(sql, params);
        return rows.map(sanitizeAccount);
    },

    async create(data) {
        const orgId = Number(data.organization_id || 1);
        const encryptedPass = data.password ? encryptSecret(data.password) : (data.password_encrypted || "");
        const port = Number(data.port) || 587;
        const secure = data.secure !== undefined ? (data.secure ? 1 : 0) : (port === 465 ? 1 : 0);

        const result = await execute(
            `INSERT INTO ${table} (
                organization_id, user_id, name, email, reply_to, host, port, username,
                password_encrypted, secure, tls_ciphers, daily_limit, hourly_limit,
                current_day_sends, current_hour_sends, last_used_at, last_reset_date,
                last_reset_hour, status, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, 'active', ?)`,
            [
                orgId,
                data.user_id ? Number(data.user_id) : null,
                String(data.name || data.email || "").trim(),
                String(data.email).toLowerCase().trim(),
                data.reply_to ? String(data.reply_to).toLowerCase().trim() : null,
                String(data.host).trim(),
                port,
                String(data.username).trim(),
                encryptedPass,
                secure,
                data.tls_ciphers || null,
                Number(data.daily_limit) || 200,
                Number(data.hourly_limit) || 50,
                getTodayString(),
                getHourString(),
                data.metadata ? JSON.stringify(data.metadata) : null,
            ]
        );

        return this.findSafeById(result.insertId, orgId);
    },

    async updateById(id, fields, orgId = null) {
        const existing = await this.findById(id, orgId);
        if (!existing) return null;

        const updates = { ...fields };
        if (updates.password) {
            updates.password_encrypted = encryptSecret(updates.password);
            delete updates.password;
        }

        const entries = Object.entries(updates).filter(([k, v]) => UPDATABLE.has(k) && v !== undefined);
        if (entries.length === 0) return this.findSafeById(id, orgId);

        const sets = entries.map(([k]) => `${k} = ?`).join(", ");
        const values = entries.map(([, v]) => (typeof v === "object" && v !== null ? JSON.stringify(v) : v));
        const params = [...values, Number(id)];

        let sql = `UPDATE ${table} SET ${sets} WHERE id = ?`;
        if (orgId !== null && orgId !== undefined) {
            sql += ` AND organization_id = ?`;
            params.push(Number(orgId));
        }

        await execute(sql, params);
        return this.findSafeById(id, orgId);
    },

    async deleteById(id, orgId = null) {
        let sql = `DELETE FROM ${table} WHERE id = ?`;
        const params = [Number(id)];
        if (orgId !== null && orgId !== undefined) {
            sql += ` AND organization_id = ?`;
            params.push(Number(orgId));
        }
        const result = await execute(sql, params);
        return Boolean(result?.affectedRows);
    },

    async resetLimitsIfNeeded(account) {
        const today = getTodayString();
        const currentHour = getHourString();
        const needsDayReset = account.last_reset_date !== today;
        const needsHourReset = account.last_reset_hour !== currentHour;

        if (needsDayReset || needsHourReset) {
            const updates = [];
            const params = [];
            if (needsDayReset) {
                updates.push("current_day_sends = 0", "last_reset_date = ?");
                params.push(today);
            }
            if (needsHourReset) {
                updates.push("current_hour_sends = 0", "last_reset_hour = ?");
                params.push(currentHour);
            }
            params.push(Number(account.id));
            await execute(`UPDATE ${table} SET ${updates.join(", ")} WHERE id = ?`, params);
            if (needsDayReset) account.current_day_sends = 0;
            if (needsHourReset) account.current_hour_sends = 0;
        }
    },

    async selectNextAvailableSender(orgId = 1) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ? AND status = 'active'
             ORDER BY current_day_sends ASC, last_used_at ASC, id ASC`,
            [Number(orgId)]
        );

        for (const row of rows) {
            const acc = mapRow(row);
            await this.resetLimitsIfNeeded(acc);
            if (acc.current_day_sends < acc.daily_limit && acc.current_hour_sends < acc.hourly_limit) {
                return acc;
            }
        }

        return null;
    },

    async reserveSenderCapacity(senderId) {
        const today = getTodayString();
        const currentHour = getHourString();
        const result = await execute(
            `UPDATE ${table}
             SET current_day_sends = CASE WHEN last_reset_date = ? THEN current_day_sends + 1 ELSE 1 END,
                 current_hour_sends = CASE WHEN last_reset_hour = ? THEN current_hour_sends + 1 ELSE 1 END,
                 last_reset_date = ?,
                 last_reset_hour = ?,
                 last_used_at = NOW()
             WHERE id = ? AND status = 'active' AND current_day_sends < daily_limit`,
            [today, currentHour, today, currentHour, Number(senderId)]
        );
        return Boolean(result?.affectedRows);
    },

    async recordFailure(senderId, errorMsg) {
        await execute(
            `UPDATE ${table}
             SET last_error = ?,
                 status = CASE WHEN last_error IS NOT NULL THEN 'error' ELSE status END
             WHERE id = ?`,
            [String(errorMsg || "Connection error").slice(0, 500), Number(senderId)]
        );
    },

    async verifyConnection(id, orgId = null) {
        const account = await this.findById(id, orgId);
        if (!account) {
            return { ok: false, error: "Sender account not found" };
        }

        const plainPassword = decryptSecret(account.password_encrypted);
        const transporter = nodemailer.createTransport({
            host: account.host,
            port: Number(account.port),
            secure: Boolean(account.secure),
            auth: {
                user: account.username,
                pass: plainPassword,
            },
            tls: {
                rejectUnauthorized: false,
                ciphers: account.tls_ciphers || undefined,
            },
            connectionTimeout: 10_000,
            greetingTimeout: 8_000,
            socketTimeout: 12_000,
        });

        try {
            await transporter.verify();
            await execute(
                `UPDATE ${table} SET verified_at = NOW(), status = 'active', last_error = NULL WHERE id = ?`,
                [Number(account.id)]
            );
            return { ok: true, message: "SMTP connection verified successfully" };
        } catch (err) {
            const errorMsg = err.message || "Failed to verify SMTP credentials";
            await execute(
                `UPDATE ${table} SET status = 'error', last_error = ? WHERE id = ?`,
                [errorMsg.slice(0, 500), Number(account.id)]
            );
            return { ok: false, error: errorMsg };
        } finally {
            try {
                transporter.close();
            } catch (_) {}
        }
    },

    getDefaultFallbackSender() {
        if (!env.smtp.host || !env.smtp.user) return null;
        return {
            id: 0,
            organization_id: 1,
            name: env.novaSenderName || "Default Sender",
            email: env.smtp.user,
            reply_to: env.smtp.user,
            host: env.smtp.host,
            port: env.smtp.port || 587,
            username: env.smtp.user,
            password_encrypted: encryptSecret(env.smtp.pass),
            secure: env.smtp.port === 465,
            daily_limit: 500,
            hourly_limit: 100,
            current_day_sends: 0,
            current_hour_sends: 0,
            status: "active",
            is_fallback: true,
        };
    },
};

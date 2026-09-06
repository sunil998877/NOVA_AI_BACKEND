import { execute, query } from "../config/db.js";
import { mailSchema } from "../schema/mail.schema.js";
import { mapRow, placeholders } from "./mapRow.js";

const { table, columns, updatable } = mailSchema;
const UPDATABLE = new Set(updatable || []);

const mapMail = (row) => {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.status = Boolean(row.status);
    return mapped;
};

export const Mail = {
    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
        return mapMail(rows[0]);
    },

    async findByCampaignId(campaignId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE campaign_id = ? ORDER BY id ASC`,
            [campaignId]
        );
        return rows.map(mapMail);
    },

    async countByCampaignId(campaignId) {
        const rows = await query(`SELECT COUNT(*) AS total FROM ${table} WHERE campaign_id = ?`, [
            campaignId,
        ]);
        return Number(rows[0]?.total || 0);
    },

    async summarizeByCampaignId(campaignId) {
        const rows = await query(
            `SELECT
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
                COALESCE(SUM(CASE WHEN delivery_status = 'sent' OR status = 1 OR sent_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS sent
             FROM ${table}
             WHERE campaign_id = ?`,
            [campaignId]
        );
        const row = rows[0] || {};
        const total = Number(row.total || 0);
        const sent = Number(row.sent || 0);
        const failed = Number(row.failed || 0);
        return { total, sent, failed, pending: Math.max(0, total - sent - failed) };
    },

    async markPendingAsSent(campaignId, sentAt) {
        const result = await execute(
            `UPDATE ${table}
             SET status = 1, delivery_status = 'sent', sent_at = ?
             WHERE campaign_id = ?
               AND delivery_status <> 'failed'
               AND status = 0
               AND sent_at IS NULL`,
            [sentAt, campaignId]
        );
        return result.affectedRows;
    },

    async findForUserCampaigns(campaignIds, campaignId, { skip = 0, limit = 100 } = {}) {
        if (campaignId) {
            return this.findByCampaignId(campaignId);
        }

        if (!campaignIds.length) return [];

        const safeSkip = Math.max(0, Number.parseInt(skip, 10) || 0);
        const safeLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE campaign_id IN (${placeholders(campaignIds)}) ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
            [...campaignIds, safeLimit, safeSkip]
        );
        return rows.map(mapMail);
    },

    async countForUserCampaigns(campaignIds, campaignId) {
        if (campaignId) {
            const rows = await query(`SELECT COUNT(*) AS total FROM ${table} WHERE campaign_id = ?`, [campaignId]);
            return Number(rows[0]?.total || 0);
        }
        if (!campaignIds.length) return 0;
        const rows = await query(
            `SELECT COUNT(*) AS total FROM ${table} WHERE campaign_id IN (${placeholders(campaignIds)})`,
            campaignIds
        );
        return Number(rows[0]?.total || 0);
    },

    async insertMany(docs) {
        if (!docs.length) return [];
        const values = docs.map((doc) => [
            doc.campaign_id,
            doc.user_id,
            doc.email ? String(doc.email).toLowerCase().trim() : null,
            doc.full_name ?? null,
            doc.status ? 1 : 0,
            doc.delivery_status || "pending",
            doc.open_count ?? 0,
            doc.sent_at ?? null,
        ]);
        const rowPlaceholders = values.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
        const flattened = values.flat();
        const result = await execute(
            `INSERT INTO ${table} (campaign_id, user_id, email, full_name, status, delivery_status, open_count, sent_at)
             VALUES ${rowPlaceholders}`,
            flattened
        );
        const ids = Array.from({ length: docs.length }, (_, index) => result.insertId + index);
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id IN (${placeholders(ids)}) ORDER BY id ASC`, ids);
        return rows.map(mapMail);
    },

    async updateById(id, fields) {
        const entries = Object.entries(fields).filter(
            ([key, value]) => UPDATABLE.has(key) && value !== undefined
        );
        if (entries.length === 0) {
            return this.findById(id);
        }

        const normalized = entries.map(([key, value]) => {
            if (key === "status") return [key, value ? 1 : 0];
            return [key, value];
        });

        const sets = normalized.map(([key]) => `${key} = ?`).join(", ");
        const values = normalized.map(([, value]) => value);
        await execute(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...values, id]);
        return this.findById(id);
    },

    async deleteByCampaignId(campaignId) {
        const result = await execute(`DELETE FROM ${table} WHERE campaign_id = ?`, [campaignId]);
        return result.affectedRows;
    },

    async findByCampaignIds(campaignIds) {
        if (!campaignIds.length) return [];
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE campaign_id IN (${placeholders(campaignIds)})`,
            campaignIds
        );
        return rows.map(mapMail);
    },
};

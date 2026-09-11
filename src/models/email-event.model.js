import { execute, query } from "../config/db.js";
import { emailEventSchema } from "../schema/email-event.schema.js";
import { mapRow, mapRows } from "./mapRow.js";

const { table, columns } = emailEventSchema;

export const EmailEvent = {
    async create({ campaignId, recipientId, eventType, url = null, userAgent = null, ipAddress = null }) {
        const result = await execute(
            `INSERT INTO ${table} (campaignId, recipientId, eventType, url, userAgent, ipAddress)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [Number(campaignId), Number(recipientId), eventType, url, userAgent, ipAddress]
        );
        return this.findById(result.insertId);
    },

    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
        return mapRow(rows[0]);
    },

    async findByCampaign(campaignId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE campaignId = ? ORDER BY timestamp DESC`,
            [Number(campaignId)]
        );
        return mapRows(rows);
    },

    async findByRecipient(recipientId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE recipientId = ? ORDER BY timestamp DESC`,
            [Number(recipientId)]
        );
        return mapRows(rows);
    },

    async hasOpened(campaignId, recipientId) {
        const rows = await query(
            `SELECT id FROM ${table} WHERE campaignId = ? AND recipientId = ? AND eventType = 'open' LIMIT 1`,
            [Number(campaignId), Number(recipientId)]
        );
        return rows.length > 0;
    },

    async getCampaignAnalytics(campaignId) {
        const [eventStats] = await query(
            `SELECT
                COUNT(CASE WHEN eventType = 'open' THEN 1 END) AS totalOpens,
                COUNT(DISTINCT CASE WHEN eventType = 'open' THEN recipientId END) AS uniqueOpens,
                COUNT(CASE WHEN eventType = 'click' THEN 1 END) AS totalClicks,
                COUNT(DISTINCT CASE WHEN eventType = 'click' THEN recipientId END) AS uniqueClicks
             FROM ${table}
             WHERE campaignId = ?`,
            [Number(campaignId)]
        );

        const [mailStats] = await query(
            `SELECT
                COUNT(id) AS totalRecipients,
                COALESCE(SUM(CASE WHEN status = 1 OR sent_at IS NOT NULL OR delivery_status != 'failed' THEN 1 ELSE 0 END), 0) AS delivered,
                COALESCE(SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
             FROM mails
             WHERE campaign_id = ?`,
            [Number(campaignId)]
        );

        const totalRecipients = Number(mailStats?.totalRecipients || 0);
        const delivered = Number(mailStats?.delivered || 0);
        const failed = Number(mailStats?.failed || 0);
        const sent = delivered;

        const uniqueOpens = Number(eventStats?.uniqueOpens || 0);
        const totalOpens = Number(eventStats?.totalOpens || 0);
        const uniqueClicks = Number(eventStats?.uniqueClicks || 0);
        const totalClicks = Number(eventStats?.totalClicks || 0);

        const unopened = Math.max(delivered - uniqueOpens, 0);
        const openRate = delivered > 0 ? Number(((uniqueOpens / delivered) * 100).toFixed(1)) : 0;
        const clickRate = delivered > 0 ? Number(((uniqueClicks / delivered) * 100).toFixed(1)) : 0;

        return {
            campaignId: Number(campaignId),
            sent,
            delivered,
            failed,
            totalRecipients,
            opened: uniqueOpens,
            unopened,
            clicked: uniqueClicks,
            uniqueOpens,
            totalOpens,
            uniqueClicks,
            totalClicks,
            openRate,
            clickRate,
        };
    },
};

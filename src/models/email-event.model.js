import { execute, query } from "../config/db.js";
import { emailEventSchema } from "../schema/email-event.schema.js";
import { mapRow, mapRows } from "./mapRow.js";

const { table, columns } = emailEventSchema;

export const EmailEvent = {
    async create({
        campaignId,
        recipientId,
        eventType,
        url = null,
        trackingToken = null,
        userAgent = null,
        ipAddress = null,
    }) {
        try {
            const result = await execute(
                `INSERT INTO ${table} (campaignId, recipientId, eventType, url, tracking_token, userAgent, ipAddress)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    Number(campaignId),
                    Number(recipientId),
                    eventType,
                    url,
                    trackingToken,
                    userAgent,
                    ipAddress,
                ]
            );
            return this.findById(result.insertId);
        } catch (err) {
            const result = await execute(
                `INSERT INTO ${table} (campaignId, recipientId, eventType, url, userAgent, ipAddress)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    Number(campaignId),
                    Number(recipientId),
                    eventType,
                    url,
                    userAgent,
                    ipAddress,
                ]
            );
            return this.findById(result.insertId);
        }
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
                COUNT(DISTINCT CASE WHEN eventType = 'click' THEN recipientId END) AS uniqueClicks,
                COUNT(CASE WHEN eventType = 'sent' THEN 1 END) AS totalSent,
                COUNT(CASE WHEN eventType = 'delivered' THEN 1 END) AS totalDeliveredEvents
             FROM ${table}
             WHERE campaignId = ?`,
            [Number(campaignId)]
        );

        const [mailStats] = await query(
            `SELECT
                COUNT(id) AS totalRecipients,
                COALESCE(SUM(CASE WHEN status = 1 OR sent_at IS NOT NULL OR delivery_status IN ('sent','opened','delivered') THEN 1 ELSE 0 END), 0) AS delivered,
                COALESCE(SUM(CASE WHEN delivery_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
                COALESCE(SUM(CASE WHEN open_count > 0 OR delivery_status = 'opened' THEN 1 ELSE 0 END), 0) AS uniqueOpenedMails,
                COALESCE(SUM(open_count), 0) AS totalOpenCount,
                COALESCE(SUM(CASE WHEN click_count > 0 THEN 1 ELSE 0 END), 0) AS uniqueClickedMails,
                COALESCE(SUM(click_count), 0) AS totalClickCount
             FROM mails
             WHERE campaign_id = ?`,
            [Number(campaignId)]
        );

        const totalRecipients = Number(mailStats?.totalRecipients || 0);
        const delivered = Number(mailStats?.delivered || 0);
        const failed = Number(mailStats?.failed || 0);
        const sent = Math.max(delivered, Number(eventStats?.totalSent || 0));

        const uniqueOpens = Math.max(
            Number(eventStats?.uniqueOpens || 0),
            Number(mailStats?.uniqueOpenedMails || 0)
        );
        const totalOpens = Math.max(
            Number(eventStats?.totalOpens || 0),
            Number(mailStats?.totalOpenCount || 0)
        );
        const uniqueClicks = Math.max(
            Number(eventStats?.uniqueClicks || 0),
            Number(mailStats?.uniqueClickedMails || 0)
        );
        const totalClicks = Math.max(
            Number(eventStats?.totalClicks || 0),
            Number(mailStats?.totalClickCount || 0)
        );

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

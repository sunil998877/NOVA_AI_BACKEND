import { execute, query } from "../config/db.js";
import { emailTrackingLinkSchema } from "../schema/email-tracking-link.schema.js";
import { mapRow, mapRows } from "./mapRow.js";

const { table, columns } = emailTrackingLinkSchema;

export const EmailTrackingLink = {
    async create({ mailId, campaignId = null, leadId = null, trackingToken, originalUrl = null, linkType = "click" }) {
        const result = await execute(
            `INSERT INTO ${table} (mail_id, campaign_id, lead_id, tracking_token, original_url, link_type)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                Number(mailId),
                campaignId != null ? Number(campaignId) : null,
                leadId != null ? Number(leadId) : null,
                String(trackingToken),
                originalUrl,
                linkType,
            ]
        );
        return this.findById(result.insertId);
    },

    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
        return mapRow(rows[0]);
    },

    async findByToken(token) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE tracking_token = ? LIMIT 1`,
            [String(token || "")]
        );
        return mapRow(rows[0]);
    },

    async findOpenTokenForMail(mailId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE mail_id = ? AND link_type = 'open'
             ORDER BY id DESC LIMIT 1`,
            [Number(mailId)]
        );
        return mapRow(rows[0]);
    },

    async findByMail(mailId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE mail_id = ? ORDER BY id ASC`,
            [Number(mailId)]
        );
        return mapRows(rows);
    },
};

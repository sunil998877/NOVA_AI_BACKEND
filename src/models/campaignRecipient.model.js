import { execute, query } from "../config/db.js";
import { campaignRecipientSchema } from "../schema/campaign-recipient.schema.js";
import { mapRow } from "./mapRow.js";

const { table } = campaignRecipientSchema;

export const CampaignRecipient = {
    async listByCampaign(campaignId) {
        const rows = await query(
            `SELECT cr.id, cr.campaign_id, cr.contact_id, cr.status, cr.sent_at, cr.created_at,
                    c.name, c.email, c.company
             FROM ${table} cr
             INNER JOIN contacts c ON c.id = cr.contact_id
             WHERE cr.campaign_id = ?
             ORDER BY c.name ASC`,
            [campaignId]
        );
        return rows.map(mapRow);
    },

    async countByCampaign(campaignId) {
        const rows = await query(
            `SELECT COUNT(*) AS total FROM ${table} WHERE campaign_id = ?`,
            [campaignId]
        );
        return Number(rows[0]?.total || 0);
    },

    async existingContactIds(campaignId) {
        const rows = await query(
            `SELECT contact_id FROM ${table} WHERE campaign_id = ?`,
            [campaignId]
        );
        return new Set(rows.map((r) => Number(r.contact_id)));
    },

    async addOne(campaignId, contactId) {
        await execute(
            `INSERT IGNORE INTO ${table} (campaign_id, contact_id, status) VALUES (?, ?, 'pending')`,
            [campaignId, contactId]
        );
    },

    async addMany(campaignId, contactIds) {
        if (!contactIds.length) return;
        for (const contactId of contactIds) {
            await this.addOne(campaignId, contactId);
        }
    },

    async remove(campaignId, contactId) {
        await execute(
            `DELETE FROM ${table} WHERE campaign_id = ? AND contact_id = ?`,
            [campaignId, contactId]
        );
    },

    async updateStatus(campaignId, contactId, status, sentAt = null) {
        await execute(
            `UPDATE ${table} SET status = ?, sent_at = ? WHERE campaign_id = ? AND contact_id = ?`,
            [status, sentAt, campaignId, contactId]
        );
    },
};

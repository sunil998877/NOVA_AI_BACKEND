import { execute, query } from "../config/db.js";
import { conversationSchema } from "../schema/conversation.schema.js";
import { mapRow, mapRows, placeholders } from "./mapRow.js";
import { Message } from "./message.model.js";

const { table, columns, updatable } = conversationSchema;
const UPDATABLE = new Set(updatable);

export const Conversation = {
    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
        return rows[0] ? mapRow(rows[0]) : null;
    },

    async findOwned(id, userId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE id = ? AND user_id = ? LIMIT 1`,
            [id, userId]
        );
        return rows[0] ? mapRow(rows[0]) : null;
    },

    async findForParticipant(id, user) {
        const conv = await this.findById(id);
        if (!conv) return null;

        if (user.role === "user") {
            if (String(conv.user_id) === String(user.id)) return conv;
            return null;
        }

        if (user.role === "influencer") {
            if (conv.influencer_id && String(conv.influencer_id) === String(user.id)) return conv;
            if (user.collabId && String(conv.id) === String(user.collabId)) return conv;
            return null;
        }

        return null;
    },

    async findByCampaignAndInfluencer(campaignId, influencerId, userId, title = null) {
        let sql = `SELECT ${columns} FROM ${table} WHERE user_id = ?`;
        const params = [userId];

        if (influencerId) {
            sql += ` AND influencer_id = ?`;
            params.push(influencerId);
            if (campaignId) {
                sql += ` AND campaign_id = ?`;
                params.push(campaignId);
            }
        } else if (campaignId) {
            sql += ` AND campaign_id = ? AND influencer_id IS NULL`;
            params.push(campaignId);
        } else if (title) {
            sql += ` AND title = ? AND influencer_id IS NULL AND campaign_id IS NULL`;
            params.push(title);
        } else {
            sql += ` AND influencer_id IS NULL AND campaign_id IS NULL`;
        }

        sql += ` ORDER BY COALESCE(last_message_at, createdAt) DESC LIMIT 1`;
        const rows = await query(sql, params);
        return rows[0] ? mapRow(rows[0]) : null;
    },

    async findOrCreate({ campaignId = null, influencerId = null, userId, title = "Chat" }) {
        let existing = await this.findByCampaignAndInfluencer(campaignId, influencerId, userId, title);
        if (existing) return existing;

        const result = await execute(
            `INSERT INTO ${table} (campaign_id, influencer_id, user_id, status, title, last_message_at)
             VALUES (?, ?, ?, 'active', ?, NOW())`,
            [campaignId || null, influencerId || null, userId, title]
        );
        return this.findById(result.insertId);
    },

    async create({ userId, user_id, campaignId = null, campaign_id = null, influencerId = null, influencer_id = null, title = "New conversation", thread_id = null, expiresAt = null }) {
        const uId = userId || user_id;
        const cId = campaignId || campaign_id || null;
        const iId = influencerId || influencer_id || null;
        const result = await execute(
            `INSERT INTO ${table} (campaign_id, influencer_id, user_id, status, title, thread_id, expiresAt, last_message_at)
             VALUES (?, ?, ?, 'active', ?, ?, ?, NOW())`,
            [cId, iId, uId, title, thread_id, expiresAt]
        );
        return this.findById(result.insertId);
    },

    async findByUser(userId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE user_id = ? ORDER BY COALESCE(last_message_at, createdAt) DESC`,
            [userId]
        );
        return mapRows(rows);
    },

    async listInfluencerConversations(userId) {
        const sql = `
            SELECT
                c.id, c.campaign_id, c.influencer_id, c.user_id, c.status,
                c.last_message_id, c.last_message_at, c.title, c.createdAt, c.updatedAt,
                i.name AS influencer_name, i.username AS influencer_username,
                i.platform AS platform, i.profile_image AS profile_image,
                i.email AS recipient_email
            FROM ${table} c
            LEFT JOIN influencers i ON c.influencer_id = i.id
            WHERE c.user_id = ? AND (c.influencer_id IS NOT NULL OR c.campaign_id IS NOT NULL)
            ORDER BY COALESCE(c.last_message_at, c.createdAt) DESC
        `;

        let rows = [];
        try {
            rows = await query(sql, [userId]);
        } catch (_) {
            rows = await query(
                `SELECT ${columns} FROM ${table} WHERE user_id = ? ORDER BY COALESCE(last_message_at, createdAt) DESC`,
                [userId]
            );
        }

        const data = await Promise.all(
            rows.map(async (row) => {
                const conv = mapRow(row);
                const unreadCount = await Message.countUnread(conv.id, "user");

                let lastMessageText = "";
                let lastSenderType = "system";
                let lastMessageAt = conv.last_message_at || conv.createdAt;

                if (conv.last_message_id) {
                    const lastMsg = await Message.findById(conv.last_message_id);
                    if (lastMsg) {
                        lastMessageText = lastMsg.message;
                        lastSenderType = lastMsg.senderType;
                        lastMessageAt = lastMsg.createdAt;
                    }
                } else {
                    const recent = await Message.findByConversation(conv.id, { limit: 1 });
                    if (recent && recent.length > 0) {
                        lastMessageText = recent[recent.length - 1].message;
                        lastSenderType = recent[recent.length - 1].senderType;
                        lastMessageAt = recent[recent.length - 1].createdAt;
                    }
                }

                return {
                    id: Number(conv.id),
                    campaignId: conv.campaign_id ? Number(conv.campaign_id) : null,
                    influencerId: conv.influencer_id ? Number(conv.influencer_id) : null,
                    userId: Number(conv.user_id),
                    status: conv.status || "active",
                    title: conv.title,
                    influencerName: row.influencer_name || conv.title || "Creator",
                    influencerUsername: row.influencer_username || "",
                    platform: row.platform || "youtube",
                    profileImage: row.profile_image || null,
                    recipientEmail: row.recipient_email || "",
                    unreadCount,
                    lastMessage: lastMessageText || "Conversation started",
                    lastMessageAt,
                    lastSenderType,
                };
            })
        );

        return data;
    },

    async updateLastMessage(id, messageId, messageAt) {
        await execute(
            `UPDATE ${table} SET last_message_id = ?, last_message_at = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
            [messageId, messageAt || new Date(), id]
        );
    },

    async updateById(id, fields) {
        const entries = Object.entries(fields).filter(
            ([key, value]) => UPDATABLE.has(key) && value !== undefined
        );
        if (entries.length === 0) {
            return this.findById(id);
        }

        const sets = entries.map(([key]) => `${key} = ?`).join(", ");
        const values = entries.map(([, value]) => value);
        await execute(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...values, id]);
        return this.findById(id);
    },

    async deleteById(id) {
        await execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
    },

    async findExpiredIds(userId) {
        const rows = await query(
            `SELECT id FROM ${table} WHERE user_id = ? AND expiresAt IS NOT NULL AND expiresAt < NOW()`,
            [userId]
        );
        return rows.map((r) => r.id);
    },

    async deleteByIds(ids = []) {
        if (!ids || ids.length === 0) return 0;
        const inClause = placeholders(ids);
        const result = await execute(`DELETE FROM ${table} WHERE id IN (${inClause})`, ids);
        return result.affectedRows || 0;
    },
};

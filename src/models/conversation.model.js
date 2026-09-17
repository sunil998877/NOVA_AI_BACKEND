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
            // Marketer access
            if (String(conv.user_id) === String(user.id)) return conv;
            return null;
        }

        if (user.role === "influencer") {
            // Influencer access (check influencer_id, or if collab id matches)
            if (conv.influencer_id && String(conv.influencer_id) === String(user.id)) return conv;
            if (user.collabId && String(conv.id) === String(user.collabId)) return conv;
            return null;
        }

        return null;
    },

    async findByCampaignAndInfluencer(campaignId, influencerId, userId) {
        let sql = `SELECT ${columns} FROM ${table} WHERE user_id = ?`;
        const params = [userId];

        if (campaignId) {
            sql += ` AND campaign_id = ?`;
            params.push(campaignId);
        }
        if (influencerId) {
            sql += ` AND influencer_id = ?`;
            params.push(influencerId);
        }

        sql += ` LIMIT 1`;
        const rows = await query(sql, params);
        return rows[0] ? mapRow(rows[0]) : null;
    },

    async findOrCreate({ campaignId = null, influencerId, userId, title = "Influencer Chat" }) {
        let existing = await this.findByCampaignAndInfluencer(campaignId, influencerId, userId);
        if (existing) return existing;

        const result = await execute(
            `INSERT INTO ${table} (campaign_id, influencer_id, user_id, status, title, last_message_at)
             VALUES (?, ?, ?, 'active', ?, NOW())`,
            [campaignId || null, influencerId, userId, title]
        );
        return this.findById(result.insertId);
    },

    async listInfluencerConversations(userId) {
        // Query conversations for user along with influencer/collaboration details
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
            // Fallback to simpler query if join fails
            rows = await query(
                `SELECT ${columns} FROM ${table} WHERE user_id = ? ORDER BY COALESCE(last_message_at, createdAt) DESC`,
                [userId]
            );
        }

        const data = await Promise.all(
            rows.map(async (row) => {
                const conv = mapRow(row);
                const unreadCount = await Message.countUnread(conv.id, "user");
                
                // Fetch last message snippet
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
};

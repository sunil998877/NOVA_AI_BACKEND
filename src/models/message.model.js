import { execute, query } from "../config/db.js";
import { messageSchema } from "../schema/message.schema.js";
import { mapRow, mapRows, placeholders } from "./mapRow.js";

const { table, columns } = messageSchema;

export const Message = {
    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
        return rows[0] ? this.formatMessage(mapRow(rows[0])) : null;
    },

    formatMessage(raw) {
        if (!raw) return null;
        return {
            id: Number(raw.id),
            conversationId: Number(raw.conversation_id),
            senderId: raw.sender_id ? Number(raw.sender_id) : null,
            senderType: raw.sender_type || (raw.role === "assistant" ? "influencer" : "user"),
            message: raw.message || raw.content || "",
            content: raw.message || raw.content || "",
            messageType: raw.message_type || "text",
            isRead: Boolean(raw.is_read),
            createdAt: raw.createdAt || raw.created_at || new Date().toISOString(),
        };
    },

    async findByConversation(conversationId, { before = null, limit = 50 } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
        let sql = `SELECT ${columns} FROM ${table} WHERE conversation_id = ?`;
        const params = [conversationId];

        if (before) {
            sql += ` AND id < ?`;
            params.push(before);
        }

        sql += ` ORDER BY id DESC LIMIT ${safeLimit}`;

        const rows = await query(sql, params);
        return rows.reverse().map((r) => this.formatMessage(mapRow(r)));
    },

    async create({ conversationId, senderId = null, senderType = "user", message, messageType = "text" }) {
        const text = String(message || "").trim();
        const result = await execute(
            `INSERT INTO ${table} (conversation_id, sender_id, sender_type, message, content, message_type, is_read)
             VALUES (?, ?, ?, ?, ?, ?, 0)`,
            [conversationId, senderId, senderType, text, text, messageType]
        );
        return this.findById(result.insertId);
    },

    async markAsRead(conversationId, readerType) {
        const targetSenderType = readerType === "user" ? "influencer" : "user";
        await execute(
            `UPDATE ${table} SET is_read = 1
             WHERE conversation_id = ? AND sender_type = ? AND is_read = 0`,
            [conversationId, targetSenderType]
        );
    },

    async countUnread(conversationId, readerType) {
        const targetSenderType = readerType === "user" ? "influencer" : "user";
        const rows = await query(
            `SELECT COUNT(*) AS total FROM ${table}
             WHERE conversation_id = ? AND sender_type = ? AND is_read = 0`,
            [conversationId, targetSenderType]
        );
        return Number(rows[0]?.total || 0);
    },

    async deleteByConversationId(conversationId) {
        const result = await execute(`DELETE FROM ${table} WHERE conversation_id = ?`, [
            conversationId,
        ]);
        return result.affectedRows;
    },

    async deleteByConversationIds(ids) {
        if (!ids.length) return 0;
        const result = await execute(
            `DELETE FROM ${table} WHERE conversation_id IN (${placeholders(ids)})`,
            ids
        );
        return result.affectedRows;
    },
};

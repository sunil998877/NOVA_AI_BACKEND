import { execute, query } from "../config/db.js";
import { messageSchema } from "../schema/message.schema.js";
import { mapRow, mapRows, placeholders } from "./mapRow.js";

const { table, columns } = messageSchema;

export const Message = {
    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
        return mapRow(rows[0]);
    },

    async findByConversation(conversationId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE conversation_id = ? ORDER BY createdAt ASC`,
            [conversationId]
        );
        return mapRows(rows);
    },

    async create(data) {
        const result = await execute(
            `INSERT INTO ${table} (conversation_id, user_id, role, content) VALUES (?, ?, ?, ?)`,
            [data.conversation_id, data.user_id, data.role, data.content]
        );
        return this.findById(result.insertId);
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

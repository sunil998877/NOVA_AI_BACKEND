import { execute, query } from "../config/db.js";
import { collaborationMessageSchema } from "../schema/collaboration-message.schema.js";
import { mapRow, mapRows } from "./mapRow.js";

const { table, columns, createTable } = collaborationMessageSchema;

export const CollaborationMessage = {
    async ensureTable() {
        try {
            await query(createTable);
        } catch (_) {}
    },

    async findById(id) {
        await this.ensureTable();
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
        return rows[0] ? mapRow(rows[0]) : null;
    },

    async findByCollaborationId(collaborationId) {
        await this.ensureTable();
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE collaboration_id = ? ORDER BY createdAt ASC`,
            [collaborationId]
        );
        return rows.map(mapRow);
    },

    async create({ collaborationId, senderType, senderName, content }) {
        await this.ensureTable();
        const result = await execute(
            `INSERT INTO ${table} (collaboration_id, sender_type, sender_name, content)
             VALUES (?, ?, ?, ?)`,
            [collaborationId, senderType, senderName || "Anonymous", content.trim()]
        );
        return this.findById(result.insertId);
    },

    async markAsRead(collaborationId, readerType) {
        await this.ensureTable();
        // If marketer reads, mark messages from influencer as read, and vice-versa
        const targetSenderType = readerType === "marketer" ? "influencer" : "marketer";
        await execute(
            `UPDATE ${table} SET read_at = CURRENT_TIMESTAMP
             WHERE collaboration_id = ? AND sender_type = ? AND read_at IS NULL`,
            [collaborationId, targetSenderType]
        );
    },

    async countUnread(collaborationId, readerType) {
        await this.ensureTable();
        const targetSenderType = readerType === "marketer" ? "influencer" : "marketer";
        const rows = await query(
            `SELECT COUNT(*) AS total FROM ${table}
             WHERE collaboration_id = ? AND sender_type = ? AND read_at IS NULL`,
            [collaborationId, targetSenderType]
        );
        return Number(rows[0]?.total || 0);
    },
};

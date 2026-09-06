import { execute, query } from "../config/db.js";
import { conversationSchema } from "../schema/conversation.schema.js";
import { mapRow, mapRows, placeholders } from "./mapRow.js";

const { table, columns, updatable } = conversationSchema;
const UPDATABLE = new Set(updatable);

export const Conversation = {
    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
        return mapRow(rows[0]);
    },

    async findOwned(id, userId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE id = ? AND user_id = ? LIMIT 1`,
            [id, userId]
        );
        return mapRow(rows[0]);
    },

    async findByUser(userId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE user_id = ? ORDER BY updatedAt DESC`,
            [userId]
        );
        return mapRows(rows);
    },

    async create(data) {
        const result = await execute(
            `INSERT INTO ${table} (user_id, title, thread_id, expiresAt) VALUES (?, ?, ?, ?)`,
            [data.user_id, data.title || "New conversation", data.thread_id ?? null, data.expiresAt]
        );
        return this.findById(result.insertId);
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
            `SELECT id FROM ${table} WHERE user_id = ? AND expiresAt <= NOW()`,
            [userId]
        );
        return rows.map((row) => row.id);
    },

    async deleteByIds(ids) {
        if (!ids.length) return 0;
        const result = await execute(
            `DELETE FROM ${table} WHERE id IN (${placeholders(ids)})`,
            ids
        );
        return result.affectedRows;
    },
};

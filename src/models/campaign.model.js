import { execute, query } from "../config/db.js";
import { campaignSchema } from "../schema/campaign.schema.js";
import { mapRow, mapRows } from "./mapRow.js";

const { table, columns, updatable } = campaignSchema;
const UPDATABLE = new Set(updatable);

export const Campaign = {
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

    async findByUser(userId, { skip = 0, limit = 10 } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
        const safeSkip = Math.max(Number(skip) || 0, 0);
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE user_id = ? ORDER BY createdAt DESC LIMIT ${safeLimit} OFFSET ${safeSkip}`,
            [userId]
        );
        return mapRows(rows);
    },

    async countByUser(userId) {
        const rows = await query(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id = ?`, [
            userId,
        ]);
        return Number(rows[0]?.total || 0);
    },

    async listIdsByUser(userId) {
        const rows = await query(`SELECT id FROM ${table} WHERE user_id = ?`, [userId]);
        return rows.map((row) => row.id);
    },

    async create(data) {
        const result = await execute(
            `INSERT INTO ${table} (title, workMail, followups, camp_status, scheduledDate, status, subject, body, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.title,
                data.workMail ?? null,
                data.followups ?? "0",
                data.camp_status ?? "Pending",
                data.scheduledDate ?? null,
                data.status || "draft",
                data.subject ?? null,
                data.body ?? null,
                data.user_id,
            ]
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
};

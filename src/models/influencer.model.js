import { execute, query } from "../config/db.js";
import { influencerSchema } from "../schema/influencer.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns, updatable } = influencerSchema;
const UPDATABLE = new Set(updatable);

const mapInfluencer = (row) => {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.verified = Boolean(row.verified);
    return mapped;
};

export const Influencer = {
    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
        return mapInfluencer(rows[0]);
    },

    async findOwned(id, userId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE id = ? AND user_id = ? LIMIT 1`,
            [id, userId]
        );
        return mapInfluencer(rows[0]);
    },

    async findByUser(userId) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE user_id = ? ORDER BY updatedAt DESC`,
            [userId]
        );
        return rows.map(mapInfluencer);
    },

    async findByUserAndHandle(userId, handle) {
        if (!handle) return null;
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE user_id = ? AND handle = ? LIMIT 1`,
            [userId, handle]
        );
        return mapInfluencer(rows[0]);
    },

    async create(data) {
        const result = await execute(
            `INSERT INTO ${table}
             (user_id, name, handle, platform, followers, engagement, niche, location, avatar, verified, status, notes, lastContact)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.user_id,
                data.name,
                data.handle ?? null,
                data.platform ?? null,
                data.followers ?? null,
                data.engagement ?? null,
                data.niche ?? null,
                data.location ?? null,
                data.avatar ?? null,
                data.verified ? 1 : 0,
                data.status || "saved",
                data.notes ?? null,
                data.lastContact ?? null,
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
        const values = entries.map(([key, value]) => {
            if (key === "verified") return value ? 1 : 0;
            return value;
        });
        await execute(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...values, id]);
        return this.findById(id);
    },

    async deleteById(id) {
        await execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
    },
};

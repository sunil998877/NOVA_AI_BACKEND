import { execute, query } from "../config/db.js";
import { contactSchema } from "../schema/contact.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns, updatable } = contactSchema;
const UPDATABLE = new Set(updatable);

export const Contact = {
    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
        return mapRow(rows[0]);
    },

    async findByEmail(email) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE email = ? LIMIT 1`,
            [String(email).toLowerCase().trim()]
        );
        return mapRow(rows[0]);
    },

    async list({ q = "", skip = 0, limit = 50 } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const safeSkip = Math.max(Number(skip) || 0, 0);
        if (q && q.trim()) {
            const like = `%${q.trim()}%`;
            const rows = await query(
                `SELECT ${columns} FROM ${table}
                 WHERE name LIKE ? OR email LIKE ? OR company LIKE ?
                 ORDER BY name ASC LIMIT ${safeLimit} OFFSET ${safeSkip}`,
                [like, like, like]
            );
            return rows.map(mapRow);
        }
        const rows = await query(
            `SELECT ${columns} FROM ${table} ORDER BY name ASC LIMIT ${safeLimit} OFFSET ${safeSkip}`,
            []
        );
        return rows.map(mapRow);
    },

    async count(q = "") {
        if (q && q.trim()) {
            const like = `%${q.trim()}%`;
            const rows = await query(
                `SELECT COUNT(*) AS total FROM ${table} WHERE name LIKE ? OR email LIKE ? OR company LIKE ?`,
                [like, like, like]
            );
            return Number(rows[0]?.total || 0);
        }
        const rows = await query(`SELECT COUNT(*) AS total FROM ${table}`, []);
        return Number(rows[0]?.total || 0);
    },

    async create(data) {
        const email = String(data.email).toLowerCase().trim();
        const result = await execute(
            `INSERT INTO ${table} (name, email, company, status) VALUES (?, ?, ?, ?)`,
            [data.name, email, data.company ?? null, data.status || "active"]
        );
        return this.findById(result.insertId);
    },

    async upsert(data) {
        const email = String(data.email).toLowerCase().trim();
        const existing = await this.findByEmail(email);
        if (existing) return existing;
        return this.create({ ...data, email });
    },

    async updateById(id, fields) {
        const entries = Object.entries(fields).filter(
            ([key, value]) => UPDATABLE.has(key) && value !== undefined
        );
        if (entries.length === 0) return this.findById(id);
        const sets = entries.map(([key]) => `${key} = ?`).join(", ");
        const values = entries.map(([, value]) => value);
        await execute(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...values, id]);
        return this.findById(id);
    },
};

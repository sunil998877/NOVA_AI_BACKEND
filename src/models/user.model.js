import { execute, query } from "../config/db.js";
import { userSchema } from "../schema/user.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns, updatable } = userSchema;
const UPDATABLE = new Set(updatable);

export const User = {
    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [id]);
        return mapRow(rows[0]);
    },

    async findByEmail(email) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE email = ? LIMIT 1`, [
            String(email).toLowerCase().trim(),
        ]);
        return mapRow(rows[0]);
    },

    async findByGoogleIdOrEmail(googleId, email) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE googleId = ? OR email = ? LIMIT 1`,
            [googleId, String(email).toLowerCase().trim()]
        );
        return mapRow(rows[0]);
    },

    async create(data) {
        const orgId = Number(data.organization_id);
        const role = String(data.role || "").trim();
        if (!Number.isFinite(orgId) || orgId < 1) {
            throw new Error("organization_id is required");
        }
        if (!role) {
            throw new Error("role is required");
        }
        const result = await execute(
            `INSERT INTO ${table} (fullName, organization, email, passwordHash, googleId, authProvider, organization_id, role)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.fullName,
                data.organization,
                String(data.email).toLowerCase().trim(),
                data.passwordHash ?? null,
                data.googleId ?? null,
                data.authProvider || "local",
                orgId,
                role,
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

    async listSalesRepIds(orgId) {
        const rows = await this.listRoutableReps(orgId);
        return rows.map((row) => Number(row.id)).filter(Boolean);
    },

    async listRoutableReps(orgId) {
        const id = Number(orgId || 1);
        const where = `organization_id = ? AND role IN ('SALESPERSON', 'SALES_MANAGER', 'ORG_ADMIN', 'SUPER_ADMIN')`;
        try {
            const rows = await query(
                `SELECT id, role, fullName, email, team, territory FROM ${table} WHERE ${where}`,
                [id]
            );
            return rows || [];
        } catch {
            const rows = await query(
                `SELECT id, role, fullName, email FROM ${table} WHERE ${where}`,
                [id]
            );
            return (rows || []).map((row) => ({ ...row, team: null, territory: null }));
        }
    },
};

import { execute, query } from "../config/db.js";
import { organizationSchema } from "../schema/organization.schema.js";
import { mapRow } from "./mapRow.js";
import { slugifyOrgName } from "../services/ase/roles.constants.js";

const { table, columns } = organizationSchema;

export const Organization = {
    async findById(id) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [Number(id)]);
        return mapRow(rows[0]);
    },

    async findBySlug(slug) {
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE slug = ? LIMIT 1`, [String(slug)]);
        return mapRow(rows[0]);
    },

    async create({ name, operating_mode = "FULLY_AUTOMATED" }) {
        const displayName = String(name || "Organization").trim() || "Organization";
        const base = slugifyOrgName(displayName);
        let slug = base;
        for (let attempt = 0; attempt < 12; attempt += 1) {
            try {
                const result = await execute(
                    `INSERT INTO ${table} (name, slug, settings, operating_mode) VALUES (?, ?, ?, ?)`,
                    [displayName, slug, JSON.stringify({}), operating_mode]
                );
                return this.findById(result.insertId);
            } catch (error) {
                if (error?.code !== "ER_DUP_ENTRY") throw error;
                slug = `${base}-${Math.random().toString(36).slice(2, 8)}`;
            }
        }
        throw new Error("Could not allocate an organization slug");
    },
};

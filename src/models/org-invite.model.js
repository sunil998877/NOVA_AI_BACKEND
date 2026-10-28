import { createHash, randomBytes } from "crypto";
import { execute, query } from "../config/db.js";
import { orgInviteSchema } from "../schema/org-invite.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = orgInviteSchema;

export function hashInviteToken(token) {
    return createHash("sha256").update(String(token || "")).digest("hex");
}

export function newInviteToken() {
    return randomBytes(24).toString("hex");
}

export const OrgInvite = {
    async create({ organization_id, email, role, invited_by, expiresAt }) {
        const token = newInviteToken();
        const result = await execute(
            `INSERT INTO ${table} (organization_id, email, role, token_hash, invited_by, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                Number(organization_id),
                String(email).toLowerCase().trim(),
                String(role),
                hashInviteToken(token),
                invited_by ? Number(invited_by) : null,
                expiresAt,
            ]
        );
        const row = mapRow(
            (await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [result.insertId]))[0]
        );
        return { ...row, token };
    },

    async findValidByToken(token) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > NOW()
             LIMIT 1`,
            [hashInviteToken(token)]
        );
        return mapRow(rows[0]);
    },

    async listByOrg(orgId, limit = 50) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE organization_id = ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [Number(orgId), Math.min(Math.max(Number(limit) || 50, 1), 200)]
        );
        return rows.map(mapRow);
    },

    async markAccepted(id) {
        await execute(`UPDATE ${table} SET accepted_at = NOW() WHERE id = ?`, [Number(id)]);
    },
};

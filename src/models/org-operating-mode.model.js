import { execute, query } from "../config/db.js";
import { OPERATING_MODES, normalizeOperatingMode } from "../services/ase/operatingMode.constants.js";

export const OrgOperatingMode = {
    async get(orgId) {
        const rows = await query(
            `SELECT operating_mode FROM organizations WHERE id = ? LIMIT 1`,
            [Number(orgId || 1)]
        );
        return normalizeOperatingMode(rows[0]?.operating_mode) || OPERATING_MODES.FULLY_AUTOMATED;
    },

    async set(orgId, mode) {
        const next = normalizeOperatingMode(mode);
        if (!next) {
            throw new Error(`Invalid operating mode: ${mode}`);
        }
        const id = Number(orgId || 1);
        const result = await execute(
            `UPDATE organizations SET operating_mode = ? WHERE id = ?`,
            [next, id]
        );
        if (!result?.affectedRows) {
            await execute(
                `INSERT INTO organizations (id, name, slug, operating_mode, settings)
                 VALUES (?, ?, ?, ?, '{}')
                 ON DUPLICATE KEY UPDATE operating_mode = VALUES(operating_mode)`,
                [id, `Organization ${id}`, `org-${id}`, next]
            );
        }
        return this.get(id);
    },
};

import { execute, query } from "../config/db.js";
import { followUpAutomationSchema } from "../schema/follow-up.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns } = followUpAutomationSchema;

export const FollowUpAutomation = {
    async getSettings(orgId = 1) {
        const id = Number(orgId || 1);
        const rows = await query(`SELECT ${columns} FROM ${table} WHERE organization_id = ? LIMIT 1`, [id]);
        if (rows && rows.length > 0) {
            return mapRow(rows[0]);
        }
        await execute(
            `INSERT INTO ${table} (organization_id, status, auto_enroll_enabled)
             VALUES (?, 'active', 1)
             ON DUPLICATE KEY UPDATE status = VALUES(status)`,
            [id]
        );
        const created = await query(`SELECT ${columns} FROM ${table} WHERE organization_id = ? LIMIT 1`, [id]);
        return mapRow(created[0]);
    },

    async updateSettings(orgId = 1, data = {}) {
        const id = Number(orgId || 1);
        await this.getSettings(id);

        const fields = [];
        const params = [];

        if (data.status !== undefined) {
            fields.push("status = ?");
            params.push(String(data.status).toLowerCase());
        }
        if (data.auto_enroll_enabled !== undefined) {
            fields.push("auto_enroll_enabled = ?");
            params.push(data.auto_enroll_enabled ? 1 : 0);
        }
        if (data.paused_reason !== undefined) {
            fields.push("paused_reason = ?");
            params.push(data.paused_reason);
        }
        if (data.paused_at !== undefined) {
            fields.push("paused_at = ?");
            params.push(data.paused_at ? new Date(data.paused_at) : null);
        }
        if (data.resumed_at !== undefined) {
            fields.push("resumed_at = ?");
            params.push(data.resumed_at ? new Date(data.resumed_at) : null);
        }
        if (data.stopped_reason !== undefined) {
            fields.push("stopped_reason = ?");
            params.push(data.stopped_reason);
        }
        if (data.stopped_at !== undefined) {
            fields.push("stopped_at = ?");
            params.push(data.stopped_at ? new Date(data.stopped_at) : null);
        }
        if (data.updated_by !== undefined) {
            fields.push("updated_by = ?");
            params.push(data.updated_by);
        }

        if (fields.length > 0) {
            params.push(id);
            await execute(`UPDATE ${table} SET ${fields.join(", ")} WHERE organization_id = ?`, params);
        }

        return this.getSettings(id);
    },

    async start(orgId = 1, user = {}) {
        return this.updateSettings(orgId, {
            status: "active",
            auto_enroll_enabled: 1,
            paused_reason: null,
            paused_at: null,
            resumed_at: new Date(),
            stopped_reason: null,
            stopped_at: null,
            updated_by: user.email || user.name || "user",
        });
    },

    async pause(orgId = 1, reason = "Automation paused", user = {}) {
        return this.updateSettings(orgId, {
            status: "paused",
            paused_reason: reason,
            paused_at: new Date(),
            updated_by: user.email || user.name || "user",
        });
    },

    async resume(orgId = 1, user = {}) {
        return this.updateSettings(orgId, {
            status: "active",
            auto_enroll_enabled: 1,
            paused_reason: null,
            paused_at: null,
            resumed_at: new Date(),
            updated_by: user.email || user.name || "user",
        });
    },

    async stop(orgId = 1, reason = "Automation stopped", user = {}) {
        return this.updateSettings(orgId, {
            status: "stopped",
            auto_enroll_enabled: 0,
            stopped_reason: reason,
            stopped_at: new Date(),
            updated_by: user.email || user.name || "user",
        });
    },

    async isAutomationActive(orgId = 1) {
        const settings = await this.getSettings(orgId);
        return settings?.status === "active";
    },

    async isAutoEnrollEnabled(orgId = 1) {
        const settings = await this.getSettings(orgId);
        return settings?.status === "active" && Boolean(settings?.auto_enroll_enabled);
    },
};

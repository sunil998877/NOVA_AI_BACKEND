import { execute, query } from "../config/db.js";
import { callSchema } from "../schema/call.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns, updatable } = callSchema;
const UPDATABLE = new Set(updatable);

const mapCall = (row) => {
    if (!row) return null;
    const mapped = mapRow(row);
    mapped.status = row.provider_status || row.status || "initiated";
    mapped.duration_seconds = row.duration_sec != null ? Number(row.duration_sec) : 0;
    mapped.billable_duration_seconds = row.billable_duration_sec != null ? Number(row.billable_duration_sec) : 0;
    mapped.provider_cost = row.cost != null ? Number(row.cost) : null;
    return mapped;
};

export const Call = {
    async create(data) {
        const orgId = Number(data.organization_id || 1);
        const idempotencyKey = data.idempotency_key || null;

        if (idempotencyKey) {
            const existing = await query(
                `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
                [orgId, idempotencyKey]
            );
            if (existing && existing.length > 0) {
                return { call: mapCall(existing[0]), created: false };
            }
        }

        if (data.provider_call_uuid) {
            const existing = await query(
                `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND provider_call_uuid = ? LIMIT 1`,
                [orgId, data.provider_call_uuid]
            );
            if (existing && existing.length > 0) {
                return { call: mapCall(existing[0]), created: false };
            }
        }

        const result = await execute(
            `INSERT INTO ${table} (
                organization_id, lead_id, provider_call_uuid, idempotency_key, phone_number, from_number,
                call_channel, call_type, initiation_source, provider, provider_status, normalized_outcome,
                business_disposition, is_answered, duration_sec, billable_duration_sec, cost, cost_status,
                hangup_cause, failure_reason, callback_id, error_details, raw_metadata, answered_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orgId,
                data.lead_id ? Number(data.lead_id) : null,
                data.provider_call_uuid || null,
                idempotencyKey,
                data.phone_number,
                data.from_number || null,
                data.call_channel || "VOICE",
                data.call_type || "OUTBOUND",
                data.initiation_source || "AUTONOMOUS_AI",
                data.provider || "plivo",
                data.provider_status || "initiated",
                data.normalized_outcome || "INITIATED",
                data.business_disposition || null,
                data.is_answered ? 1 : 0,
                Number(data.duration_sec || 0),
                Number(data.billable_duration_sec || 0),
                data.cost !== undefined && data.cost !== null ? Number(data.cost) : null,
                data.cost_status || (data.cost !== undefined && data.cost !== null ? "FINAL" : "PENDING"),
                data.hangup_cause || null,
                data.failure_reason || null,
                data.callback_id ? Number(data.callback_id) : null,
                data.error_details || null,
                data.raw_metadata ? JSON.stringify(data.raw_metadata) : null,
                data.answered_at || null,
                data.completed_at || null,
            ]
        );

        const rows = await query(`SELECT ${columns} FROM ${table} WHERE id = ? LIMIT 1`, [result.insertId]);
        return { call: mapCall(rows[0]), created: true };
    },

    async findById(arg1, arg2) {
        const orgId = arg2 !== undefined ? Number(arg1) : 1;
        const id = arg2 !== undefined ? Number(arg2) : Number(arg1);
        const rows = await query(
            `SELECT c.*, l.name as lead_name, l.email as lead_email, l.company as lead_company,
                    l.priority as lead_priority, l.status as lead_status, l.phone as lead_phone
             FROM ${table} c
             LEFT JOIN leads l ON c.lead_id = l.id
             WHERE c.organization_id = ? AND c.id = ? LIMIT 1`,
            [Number(orgId), Number(id)]
        );
        return rows[0] ? mapCall(rows[0]) : null;
    },

    async findByIdAnyOrg(id) {
        const rows = await query(
            `SELECT c.*, l.name as lead_name, l.email as lead_email, l.company as lead_company,
                    l.priority as lead_priority, l.status as lead_status, l.phone as lead_phone
             FROM ${table} c
             LEFT JOIN leads l ON c.lead_id = l.id
             WHERE c.id = ? LIMIT 1`,
            [Number(id)]
        );
        return rows[0] ? mapCall(rows[0]) : null;
    },

    async findByProviderUuid(arg1, arg2) {
        const orgId = arg2 !== undefined ? Number(arg1) : 1;
        const providerCallUuid = arg2 !== undefined ? String(arg2) : String(arg1);
        if (!providerCallUuid) return null;
        const rows = await query(
            `SELECT c.*, l.name as lead_name, l.email as lead_email, l.company as lead_company,
                    l.priority as lead_priority, l.status as lead_status, l.phone as lead_phone
             FROM ${table} c
             LEFT JOIN leads l ON c.lead_id = l.id
             WHERE c.organization_id = ? AND c.provider_call_uuid = ? LIMIT 1`,
            [Number(orgId), String(providerCallUuid)]
        );
        return rows[0] ? mapCall(rows[0]) : null;
    },

    async findByProviderCallUuid(arg1, arg2) {
        return this.findByProviderUuid(arg1, arg2);
    },

    async findByProviderUuidAnyOrg(providerCallUuid) {
        if (!providerCallUuid) return null;
        const rows = await query(
            `SELECT c.*, l.name as lead_name, l.email as lead_email, l.company as lead_company,
                    l.priority as lead_priority, l.status as lead_status, l.phone as lead_phone
             FROM ${table} c
             LEFT JOIN leads l ON c.lead_id = l.id
             WHERE c.provider_call_uuid = ? LIMIT 1`,
            [String(providerCallUuid)]
        );
        return rows[0] ? mapCall(rows[0]) : null;
    },

    async updateById(arg1, arg2, arg3) {
        const orgId = arg3 !== undefined ? Number(arg1) : 1;
        const id = arg3 !== undefined ? Number(arg2) : Number(arg1);
        const fields = { ...(arg3 !== undefined ? arg3 : arg2) };

        if (fields.status && !fields.provider_status) {
            fields.provider_status = fields.status;
        }
        if (fields.duration_seconds != null && fields.duration_sec == null) {
            fields.duration_sec = fields.duration_seconds;
        }
        if (fields.billable_duration_seconds != null && fields.billable_duration_sec == null) {
            fields.billable_duration_sec = fields.billable_duration_seconds;
        }
        if (fields.provider_cost != null && fields.cost == null) {
            fields.cost = fields.provider_cost;
        }

        const entries = Object.entries(fields).filter(
            ([key, value]) => UPDATABLE.has(key) && value !== undefined
        );
        if (entries.length === 0) return this.findById(orgId, id);

        const sets = entries.map(([key]) => `${key} = ?`).join(", ");
        const values = entries.map(([key, value]) => {
            if (key === "raw_metadata" && typeof value === "object" && value !== null) {
                return JSON.stringify(value);
            }
            return value;
        });

        await execute(`UPDATE ${table} SET ${sets} WHERE organization_id = ? AND id = ?`, [
            ...values,
            Number(orgId),
            Number(id),
        ]);
        return this.findById(orgId, id);
    },

    async updateByProviderUuid(arg1, arg2, arg3, arg4) {
        let orgId = 1;
        let providerCallUuid = "";
        let fields = {};
        let fallbackId = null;

        if (typeof arg1 === "number" && typeof arg2 === "string") {
            orgId = arg1;
            providerCallUuid = arg2;
            fields = arg3 || {};
            fallbackId = arg4 || null;
        } else {
            providerCallUuid = arg1;
            fields = arg2 || {};
            fallbackId = arg3 || null;
            orgId = arg4 || 1;
        }

        let existing = await this.findByProviderUuid(orgId, providerCallUuid);
        if (!existing && fallbackId) {
            existing = await this.findById(orgId, fallbackId);
        }
        if (!existing) return null;
        return this.updateById(orgId, existing.id, fields);
    },

    async updateByProviderCallUuid(arg1, arg2, arg3, arg4) {
        return this.updateByProviderUuid(arg1, arg2, arg3, arg4);
    },

    async list(orgId, { lead_id = null, status = "", outcome = "", source = "", search = "", limit = 50, skip = 0 } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const safeSkip = Math.max(Number(skip) || 0, 0);
        const where = ["c.organization_id = ?"];
        const params = [Number(orgId)];

        if (lead_id) {
            where.push("c.lead_id = ?");
            params.push(Number(lead_id));
        }

        if (status) {
            where.push("c.provider_status = ?");
            params.push(status);
        }

        if (outcome) {
            where.push("c.normalized_outcome = ?");
            params.push(outcome);
        }

        if (source) {
            where.push("c.initiation_source = ?");
            params.push(source);
        }

        if (search) {
            const term = `%${search.trim().toLowerCase()}%`;
            where.push("(LOWER(c.phone_number) LIKE ? OR LOWER(COALESCE(l.name, '')) LIKE ? OR LOWER(COALESCE(l.company, '')) LIKE ? OR LOWER(COALESCE(c.provider_call_uuid, '')) LIKE ?)");
            params.push(term, term, term, term);
        }

        const whereSql = where.join(" AND ");
        const rows = await query(
            `SELECT c.*, l.name as lead_name, l.email as lead_email, l.company as lead_company,
                    l.priority as lead_priority, l.status as lead_status, l.phone as lead_phone
             FROM ${table} c
             LEFT JOIN leads l ON c.lead_id = l.id
             WHERE ${whereSql}
             ORDER BY c.created_at DESC
             LIMIT ${safeLimit} OFFSET ${safeSkip}`,
            params
        );
        return rows.map(mapRow);
    },

    async countStats(orgId) {
        const rows = await query(
            `SELECT
                COUNT(*) as total_outbound,
                SUM(CASE WHEN is_answered = 1 THEN 1 ELSE 0 END) as answered_count,
                SUM(CASE WHEN is_answered = 1 THEN duration_sec ELSE 0 END) as total_talk_sec,
                SUM(CASE WHEN is_answered = 0 THEN duration_sec ELSE 0 END) as total_ringing_sec,
                SUM(COALESCE(cost, 0)) as total_cost,
                SUM(CASE WHEN cost IS NULL OR cost_status = 'PENDING' THEN 1 ELSE 0 END) as pending_cost_count
             FROM ${table}
             WHERE organization_id = ? AND call_type = 'OUTBOUND' AND provider_status != 'request_failed'`,
            [Number(orgId)]
        );

        const r = rows[0] || {};
        const total = Number(r.total_outbound || 0);
        const answered = Number(r.answered_count || 0);
        const talkSec = Number(r.total_talk_sec || 0);
        const ringingSec = Number(r.total_ringing_sec || 0);
        const cost = Number(r.total_cost || 0);
        const pendingCost = Number(r.pending_cost_count || 0);

        return {
            totalCalls: total,
            answeredCalls: answered,
            answerRate: total > 0 ? Number(((answered / total) * 100).toFixed(1)) : 0,
            totalMinutes: Math.round(talkSec / 60),
            totalSeconds: talkSec,
            ringingSeconds: ringingSec,
            totalCost: Number(cost.toFixed(4)),
            pendingCostCount: pendingCost,
        };
    },

    async getStats(orgId = 1) {
        return this.countStats(orgId);
    },

    async countActiveOutbound(orgId) {
        const rows = await query(
            `SELECT COUNT(*) AS total FROM ${table}
             WHERE organization_id = ?
               AND completed_at IS NULL
               AND provider_status IN ('initiated', 'ringing', 'in-progress', 'queued', 'unknown')`,
            [Number(orgId || 1)]
        );
        return Number(rows?.[0]?.total || 0);
    },

    async findOpenForPoll({ olderThanSec = 8, newerThanHours = 8, limit = 20 } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE completed_at IS NULL
               AND provider_status IN ('initiated', 'ringing', 'in-progress', 'queued', 'unknown')
               AND provider_call_uuid IS NOT NULL
               AND provider_call_uuid NOT LIKE 'plivo_sim_%'
               AND provider_call_uuid NOT LIKE 'sim_%'
               AND provider_call_uuid NOT LIKE 'mock-uuid%'
               AND provider_call_uuid NOT LIKE 'uuid-order-%'
               AND phone_number NOT LIKE '%555%'
               AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
               AND created_at <= DATE_SUB(NOW(), INTERVAL ? SECOND)
             ORDER BY created_at DESC
             LIMIT ${safeLimit}`,
            [Number(newerThanHours), Number(olderThanSec)]
        );
        return rows.map(mapCall);
    },
};

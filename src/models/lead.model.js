import { execute, query } from "../config/db.js";
import { leadSchema } from "../schema/lead.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns, updatable } = leadSchema;
const UPDATABLE = new Set(updatable);

const parseJson = (value, fallback) => {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const toLead = (row) => {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.tags = parseJson(row.tags, []);
    mapped.metadata = parseJson(row.metadata, {});
    mapped.segment_attributes = parseJson(row.segment_attributes, {});
    mapped.attempt_counters = parseJson(row.attempt_counters, { email: 0, voice: 0, total: 0 });
    mapped.email_consent = parseJson(row.email_consent, null);
    mapped.voice_consent = parseJson(row.voice_consent, null);
    mapped.whatsapp_consent = parseJson(row.whatsapp_consent, null);
    if (row.callback_id || row.callback_due_at || row.callback_due) {
        mapped.callback = {
            id: row.callback_id || null,
            due_at: row.callback_due_at || row.callback_due || null,
            status: row.callback_status || "OPEN",
            sla_status: row.callback_sla_status || "ON_TRACK",
            notes: row.callback_notes || null,
            rep_name: row.callback_rep_name || mapped.assigned_rep_name || null,
        };
    } else {
        mapped.callback = null;
    }
    return mapped;
};

const serialize = (key, value) => {
    const jsonKeys = [
        "tags",
        "metadata",
        "segment_attributes",
        "attempt_counters",
        "email_consent",
        "voice_consent",
        "whatsapp_consent",
    ];
    if (jsonKeys.includes(key) && value != null && typeof value !== "string") {
        return JSON.stringify(value);
    }
    return value;
};

export const Lead = {
    async findById(id, orgId = null) {
        const selected = columns.split(",").map((column) => `l.${column.trim()}`).join(", ");
        let sql = `SELECT ${selected}, u.fullName AS assigned_rep_name,
                     cb.id AS callback_id,
                     cb.due_at AS callback_due_at,
                     cb.status AS callback_status,
                     cb.sla_status AS callback_sla_status,
                     cb.notes AS callback_notes,
                     cb_u.fullName AS callback_rep_name
             FROM ${table} l
             LEFT JOIN users u ON u.id = l.assigned_rep_id
             LEFT JOIN (
                 SELECT c1.id, c1.lead_id, c1.due_at, c1.status, c1.sla_status, c1.notes, c1.assigned_rep_id
                 FROM callbacks c1
                 INNER JOIN (
                     SELECT lead_id, MAX(id) AS max_id
                     FROM callbacks
                     WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
                     GROUP BY lead_id
                 ) c2 ON c1.id = c2.max_id
             ) cb ON cb.lead_id = l.id
             LEFT JOIN users cb_u ON cb.assigned_rep_id = cb_u.id
             WHERE l.id = ?`;
        const params = [id];
        if (orgId) {
            sql += ` AND l.organization_id = ?`;
            params.push(orgId);
        }
        sql += ` LIMIT 1`;
        const rows = await query(sql, params);
        return toLead(rows[0]);
    },

    async findByEmail(orgId, email) {
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND email = ? LIMIT 1`,
            [orgId, String(email).toLowerCase().trim()]
        );
        return toLead(rows[0]);
    },

    async findByPhone(orgId, phone) {
        if (!phone) return null;
        const cleaned = String(phone).replace(/[^\d+]/g, "").trim();
        if (!cleaned) return null;
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND phone = ? LIMIT 1`,
            [orgId, cleaned]
        );
        return toLead(rows[0]);
    },

    async findByDomain(orgId, domain) {
        if (!domain) return null;
        const cleanDomain = String(domain).toLowerCase().trim();
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND email LIKE ? LIMIT 1`,
            [orgId, `%@${cleanDomain}`]
        );
        return toLead(rows[0]);
    },

    async findByExternalId(orgId, source, externalId) {
        if (!externalId) return null;
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE organization_id = ? AND source = ? AND external_id = ? LIMIT 1`,
            [orgId, source, String(externalId)]
        );
        return toLead(rows[0]);
    },

    async list(orgId, { q = "", source = "", status = "", priority = null, assigned_rep_id = null, skip = 0, limit = 50 } = {}) {
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const safeSkip = Math.max(Number(skip) || 0, 0);
        const where = ["l.organization_id = ?"];
        const params = [orgId];

        if (source) {
            where.push("l.source = ?");
            params.push(source);
        }
        if (status) {
            where.push("l.status = ?");
            params.push(status);
        }
        if (priority !== null && priority !== undefined) {
            where.push("l.priority = ?");
            params.push(Number(priority));
        }
        if (assigned_rep_id) {
            where.push("l.assigned_rep_id = ?");
            params.push(Number(assigned_rep_id));
        }
        if (q && q.trim()) {
            const like = `%${q.trim()}%`;
            where.push("(l.name LIKE ? OR l.email LIKE ? OR l.company LIKE ? OR l.phone LIKE ?)");
            params.push(like, like, like, like);
        }

        const whereSql = where.join(" AND ");
        const selected = columns.split(",").map((column) => `l.${column.trim()}`).join(", ");
        const rows = await query(
            `SELECT ${selected}, u.fullName AS assigned_rep_name,
                    cb.id AS callback_id,
                    cb.due_at AS callback_due_at,
                    cb.status AS callback_status,
                    cb.sla_status AS callback_sla_status,
                    cb.notes AS callback_notes,
                    cb_u.fullName AS callback_rep_name
             FROM ${table} l
             LEFT JOIN users u ON u.id = l.assigned_rep_id
             LEFT JOIN (
                 SELECT c1.id, c1.lead_id, c1.due_at, c1.status, c1.sla_status, c1.notes, c1.assigned_rep_id
                 FROM callbacks c1
                 INNER JOIN (
                     SELECT lead_id, MAX(id) AS max_id
                     FROM callbacks
                     WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
                     GROUP BY lead_id
                 ) c2 ON c1.id = c2.max_id
             ) cb ON cb.lead_id = l.id
             LEFT JOIN users cb_u ON cb.assigned_rep_id = cb_u.id
             WHERE ${whereSql}
             ORDER BY l.priority DESC, l.created_at DESC LIMIT ${safeLimit} OFFSET ${safeSkip}`,
            params
        );
        const countRows = await query(`SELECT COUNT(*) AS total FROM ${table} l WHERE ${whereSql}`, params);
        return { items: rows.map(toLead), total: Number(countRows[0]?.total || 0) };
    },

    async countByStatus(orgId) {
        const rows = await query(
            `SELECT status, COUNT(*) AS total FROM ${table} WHERE organization_id = ? GROUP BY status`,
            [orgId]
        );
        return Object.fromEntries(rows.map((r) => [r.status, Number(r.total)]));
    },

    async countBySource(orgId) {
        const rows = await query(
            `SELECT source, COUNT(*) AS total FROM ${table} WHERE organization_id = ? GROUP BY source`,
            [orgId]
        );
        return Object.fromEntries(rows.map((r) => [r.source, Number(r.total)]));
    },

    async findDueForAction(limit = 20, now = new Date()) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE next_action_time IS NOT NULL 
               AND next_action_time <= ?
               AND do_not_contact = 0
               AND status NOT IN ('CLOSED_WON', 'CLOSED_LOST', 'CLOSED_UNQUALIFIED', 'SUPPRESSED_DNC')
             ORDER BY priority DESC, next_action_time ASC
             LIMIT ?`,
            [now, Number(limit) || 20]
        );
        return rows.map(toLead);
    },

    async findUnscheduledNew(limit = 10) {
        const rows = await query(
            `SELECT ${columns} FROM ${table}
             WHERE (status = 'NEW' OR (status = 'QUEUED' AND next_action_time IS NULL))
               AND do_not_contact = 0
               AND status NOT IN ('CLOSED_WON', 'CLOSED_LOST', 'CLOSED_UNQUALIFIED', 'SUPPRESSED_DNC')
             ORDER BY priority DESC, created_at ASC
             LIMIT ?`,
            [Number(limit) || 10]
        );
        return rows.map(toLead);
    },


    async create(data) {
        const orgId = Number(data.organization_id || data.organizationId || 1);
        const resolvedName = data.name || [data.first_name, data.last_name].filter(Boolean).join(" ").trim() || null;
        const result = await execute(
            `INSERT INTO ${table} (
                organization_id, user_id, name, first_name, last_name, email,
                company, phone, whatsapp_number, tags, source, external_id,
                segment_attributes, priority, status, email_consent, voice_consent,
                whatsapp_consent, assigned_rep_id, next_action, next_action_time,
                last_contacted_at, attempt_counters, callback_due, disposition,
                do_not_contact, health, metadata, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                orgId,
                data.userId ?? data.user_id ?? null,
                resolvedName,
                data.first_name ?? null,
                data.last_name ?? null,
                String(data.email).toLowerCase().trim(),
                data.company ?? null,
                data.phone ?? null,
                data.whatsapp_number ?? null,
                serialize("tags", data.tags || []),
                data.source || "API",
                data.external_id ?? data.externalId ?? null,
                serialize("segment_attributes", data.segment_attributes || {}),
                Number(data.priority ?? 50),
                data.status || "NEW",
                serialize("email_consent", data.email_consent || null),
                serialize("voice_consent", data.voice_consent || null),
                serialize("whatsapp_consent", data.whatsapp_consent || null),
                data.assigned_rep_id ? Number(data.assigned_rep_id) : null,
                data.next_action ?? null,
                data.next_action_time ?? null,
                data.last_contacted_at ?? null,
                serialize("attempt_counters", data.attempt_counters || { email: 0, voice: 0, total: 0 }),
                data.callback_due ?? null,
                data.disposition ?? null,
                data.do_not_contact ? 1 : 0,
                data.health || "GREEN",
                serialize("metadata", data.metadata || {}),
                data.created_at ? new Date(data.created_at) : new Date(),
            ]
        );
        return this.findById(result.insertId, orgId);
    },

    async updateById(id, fields, orgId = null) {
        const entries = Object.entries(fields).filter(
            ([key, value]) => UPDATABLE.has(key) && value !== undefined
        );
        if (entries.length === 0) return this.findById(id, orgId);

        const sets = entries.map(([key]) => `${key} = ?`).join(", ");
        const values = entries.map(([key, value]) => serialize(key, value));
        
        let sql = `UPDATE ${table} SET ${sets} WHERE id = ?`;
        const params = [...values, id];
        if (orgId) {
            sql += ` AND organization_id = ?`;
            params.push(orgId);
        }
        await execute(sql, params);
        return this.findById(id, orgId);
    },

    async deleteById(id, orgId = null) {
        let sql = `DELETE FROM ${table} WHERE id = ?`;
        const params = [id];
        if (orgId) {
            sql += ` AND organization_id = ?`;
            params.push(orgId);
        }
        const result = await execute(sql, params);
        return result.affectedRows > 0;
    },
};

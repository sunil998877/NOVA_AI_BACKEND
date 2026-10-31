import { execute, query } from "../config/db.js";
import { aseCadenceEnrollmentSchema, aseCadencePolicySchema, aseCadenceStepSchema } from "../schema/ase-cadence.schema.js";
import { OPEN_ENROLLMENT_STATUSES, STEP_STATUS } from "../services/ase/cadence/cadence.constants.js";
import { mapRow, placeholders } from "./mapRow.js";

const policyTable = aseCadencePolicySchema.table;
const enrollmentTable = aseCadenceEnrollmentSchema.table;
const stepTable = aseCadenceStepSchema.table;

const parseJson = (value, fallback = null) => {
    if (value == null || value === "") return fallback;
    if (typeof value === "object" && !(value instanceof Buffer)) return value;
    try {
        return JSON.parse(String(value));
    } catch {
        return fallback;
    }
};

const isDup = (err) => err?.code === "ER_DUP_ENTRY" || err?.errno === 1062;
const toJson = (value) => (value == null ? null : JSON.stringify(value));
const clampLimit = (value, fallback = 50, max = 200) => Math.min(Math.max(Number(value) || fallback, 1), max);

const ENROLLMENT_JSON = new Set(["policy_snapshot", "flags"]);
const STEP_JSON = new Set(["model_recommendation", "draft", "result"]);
const ENROLLMENT_FIELDS = new Set(["status", "stage", "latest_outcome", "status_reason", "flags", "paused_at", "completed_at", "last_event_at", "policy_snapshot"]);
const STEP_FIELDS = new Set(["status", "channel_state", "due_at", "decision_reason", "model_recommendation", "call_id", "provider_ref", "draft", "result", "approved_by", "approved_at", "locked_at", "executed_at", "completed_at"]);

function toPolicy(row) {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.settings = parseJson(row.settings, {});
    mapped.is_default = Boolean(row.is_default);
    mapped.is_active = Boolean(row.is_active);
    return mapped;
}

function toEnrollment(row) {
    const mapped = mapRow(row);
    if (!mapped) return null;
    mapped.policy_snapshot = parseJson(row.policy_snapshot, {});
    mapped.flags = parseJson(row.flags, {}) || {};
    return mapped;
}

function toStep(row) {
    const mapped = mapRow(row);
    if (!mapped) return null;
    for (const key of STEP_JSON) mapped[key] = parseJson(row[key], null);
    return mapped;
}

function buildSet(patch, allowed, jsonFields) {
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(patch || {})) {
        if (!allowed.has(key) || value === undefined) continue;
        sets.push(`${key} = ?`);
        params.push(jsonFields.has(key) ? toJson(value) : value);
    }
    return { sets, params };
}

export const CadencePolicy = {
    async findById(orgId, id) {
        const rows = await query(
            `SELECT ${aseCadencePolicySchema.columns} FROM ${policyTable} WHERE organization_id = ? AND id = ? LIMIT 1`,
            [Number(orgId), Number(id)]
        );
        return toPolicy(rows[0]);
    },

    async findDefault(orgId) {
        const rows = await query(
            `SELECT ${aseCadencePolicySchema.columns} FROM ${policyTable}
             WHERE organization_id = ? AND is_default = 1 LIMIT 1`,
            [Number(orgId)]
        );
        return toPolicy(rows[0]);
    },

    async list(orgId) {
        const rows = await query(
            `SELECT ${aseCadencePolicySchema.columns} FROM ${policyTable}
             WHERE organization_id = ? ORDER BY is_default DESC, updated_at DESC LIMIT 100`,
            [Number(orgId)]
        );
        return rows.map(toPolicy);
    },

    async create(orgId, { name, settings, isDefault = false, createdBy = null }) {
        try {
            const result = await execute(
                `INSERT INTO ${policyTable} (organization_id, name, is_default, is_active, settings, created_by)
                 VALUES (?, ?, ?, 1, ?, ?)`,
                [Number(orgId), String(name || "Default cadence").slice(0, 160), isDefault ? 1 : 0, toJson(settings), createdBy ? Number(createdBy) : null]
            );
            return { created: true, policy: await this.findById(orgId, result.insertId) };
        } catch (err) {
            if (isDup(err) && isDefault) return { created: false, policy: await this.findDefault(orgId) };
            throw err;
        }
    },

    async update(orgId, id, { name, settings, isActive, expectedVersion = null }) {
        const sets = ["version = version + 1"];
        const params = [];
        if (name !== undefined) {
            sets.push("name = ?");
            params.push(String(name).slice(0, 160));
        }
        if (settings !== undefined) {
            sets.push("settings = ?");
            params.push(toJson(settings));
        }
        if (isActive !== undefined) {
            sets.push("is_active = ?");
            params.push(isActive ? 1 : 0);
        }
        let where = "organization_id = ? AND id = ?";
        params.push(Number(orgId), Number(id));
        if (expectedVersion != null) {
            where += " AND version = ?";
            params.push(Number(expectedVersion));
        }
        const result = await execute(`UPDATE ${policyTable} SET ${sets.join(", ")} WHERE ${where}`, params);
        if (!result.affectedRows) return null;
        return this.findById(orgId, id);
    },

    async setDefault(orgId, id) {
        await execute(
            `UPDATE ${policyTable}
             SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END
             WHERE organization_id = ? AND (is_default = 1 OR id = ?)
             ORDER BY is_default DESC`,
            [Number(id), Number(orgId), Number(id)]
        );
        return this.findById(orgId, id);
    },
};

export const CadenceEnrollment = {
    async findById(orgId, id) {
        const rows = await query(
            `SELECT ${aseCadenceEnrollmentSchema.columns} FROM ${enrollmentTable} WHERE organization_id = ? AND id = ? LIMIT 1`,
            [Number(orgId), Number(id)]
        );
        return toEnrollment(rows[0]);
    },

    async findOpenByLead(orgId, leadId) {
        const rows = await query(
            `SELECT ${aseCadenceEnrollmentSchema.columns} FROM ${enrollmentTable}
             WHERE organization_id = ? AND lead_id = ? AND open_slot = 1 LIMIT 1`,
            [Number(orgId), Number(leadId)]
        );
        return toEnrollment(rows[0]);
    },

    async findLatestByLead(orgId, leadId) {
        const rows = await query(
            `SELECT ${aseCadenceEnrollmentSchema.columns} FROM ${enrollmentTable}
             WHERE organization_id = ? AND lead_id = ?
             ORDER BY (open_slot = 1) DESC, created_at DESC, id DESC LIMIT 1`,
            [Number(orgId), Number(leadId)]
        );
        return toEnrollment(rows[0]);
    },

    async findOpenByLeads(orgId, leadIds) {
        const ids = [...new Set((leadIds || []).map(Number).filter(Boolean))].slice(0, 500);
        if (!ids.length) return [];
        const rows = await query(
            `SELECT ${aseCadenceEnrollmentSchema.columns} FROM ${enrollmentTable}
             WHERE organization_id = ? AND open_slot = 1 AND lead_id IN (${placeholders(ids)})`,
            [Number(orgId), ...ids]
        );
        return rows.map(toEnrollment);
    },

    async create({ organizationId, leadId, policyId, policySnapshot, stage, enrolledBy = null, startedAt = new Date() }) {
        try {
            const result = await execute(
                `INSERT INTO ${enrollmentTable}
                 (organization_id, lead_id, policy_id, policy_snapshot, status, stage, flags, enrolled_by, started_at, last_event_at)
                 VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
                [Number(organizationId), Number(leadId), Number(policyId), toJson(policySnapshot), stage, toJson({}), enrolledBy ? Number(enrolledBy) : null, startedAt, startedAt]
            );
            return { created: true, enrollment: await this.findById(organizationId, result.insertId) };
        } catch (err) {
            if (isDup(err)) return { created: false, enrollment: await this.findOpenByLead(organizationId, leadId) };
            throw err;
        }
    },

    async transition(orgId, id, { fromStatuses = null, patch = {}, mergeFlags = null, incrementCalls = 0, incrementEmails = 0 }) {
        const { sets, params } = buildSet(patch, ENROLLMENT_FIELDS, ENROLLMENT_JSON);
        if (mergeFlags && Object.keys(mergeFlags).length) {
            sets.push("flags = JSON_MERGE_PATCH(COALESCE(flags, JSON_OBJECT()), CAST(? AS JSON))");
            params.push(toJson(mergeFlags));
        }
        if (incrementCalls) {
            sets.push("call_attempts = call_attempts + ?");
            params.push(Number(incrementCalls));
        }
        if (incrementEmails) {
            sets.push("email_attempts = email_attempts + ?");
            params.push(Number(incrementEmails));
        }
        if (!sets.length) return this.findById(orgId, id);
        sets.push("version = version + 1");
        let where = "organization_id = ? AND id = ?";
        params.push(Number(orgId), Number(id));
        if (Array.isArray(fromStatuses) && fromStatuses.length) {
            where += ` AND status IN (${placeholders(fromStatuses)})`;
            params.push(...fromStatuses);
        }
        const result = await execute(`UPDATE ${enrollmentTable} SET ${sets.join(", ")} WHERE ${where}`, params);
        if (!result.affectedRows) return null;
        return this.findById(orgId, id);
    },

    async countByStatus(orgId) {
        const rows = await query(
            `SELECT status, COUNT(*) AS total FROM ${enrollmentTable}
             WHERE organization_id = ? AND status IN (${placeholders(OPEN_ENROLLMENT_STATUSES)})
             GROUP BY status`,
            [Number(orgId), ...OPEN_ENROLLMENT_STATUSES]
        );
        return Object.fromEntries(rows.map((r) => [r.status, Number(r.total)]));
    },

    async findOrphaned(olderThan, limit = 100) {
        const rows = await query(
            `SELECT e.id, e.organization_id FROM ${enrollmentTable} e
             WHERE e.status = 'ACTIVE' AND e.last_event_at < ?
               AND NOT EXISTS (
                   SELECT 1 FROM ${stepTable} s
                   WHERE s.enrollment_id = e.id AND s.status IN ('SCHEDULED', 'EXECUTING', 'AWAITING_OUTCOME', 'PENDING_APPROVAL')
               )
             ORDER BY e.last_event_at ASC LIMIT ?`,
            [olderThan, clampLimit(limit, 100, 500)]
        );
        return rows.map((r) => ({ id: Number(r.id), organization_id: Number(r.organization_id) }));
    },
};

export const CadenceStep = {
    async findById(orgId, id) {
        const rows = await query(
            `SELECT ${aseCadenceStepSchema.columns} FROM ${stepTable} WHERE organization_id = ? AND id = ? LIMIT 1`,
            [Number(orgId), Number(id)]
        );
        return toStep(rows[0]);
    },

    async findByKey(enrollmentId, stepKey) {
        const rows = await query(
            `SELECT ${aseCadenceStepSchema.columns} FROM ${stepTable} WHERE enrollment_id = ? AND step_key = ? LIMIT 1`,
            [Number(enrollmentId), String(stepKey)]
        );
        return toStep(rows[0]);
    },

    async findByCallId(orgId, callId) {
        const rows = await query(
            `SELECT ${aseCadenceStepSchema.columns} FROM ${stepTable}
             WHERE organization_id = ? AND call_id = ? ORDER BY id DESC LIMIT 1`,
            [Number(orgId), Number(callId)]
        );
        return toStep(rows[0]);
    },

    async insert({ organizationId, enrollmentId, leadId, stepKey, action, purpose, dueAt, decidedBy, reason, modelRecommendation = null, status = STEP_STATUS.SCHEDULED, channelState = null }) {
        try {
            const result = await execute(
                `INSERT INTO ${stepTable}
                 (organization_id, enrollment_id, lead_id, step_key, action, purpose, status, channel_state, due_at, decided_by, decision_reason, model_recommendation)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    Number(organizationId),
                    Number(enrollmentId),
                    Number(leadId),
                    String(stepKey).slice(0, 64),
                    action,
                    purpose || null,
                    status,
                    channelState,
                    dueAt,
                    decidedBy || "POLICY",
                    reason ? String(reason).slice(0, 255) : null,
                    toJson(modelRecommendation),
                ]
            );
            return { created: true, step: await this.findById(organizationId, result.insertId) };
        } catch (err) {
            if (isDup(err)) return { created: false, step: await this.findByKey(enrollmentId, stepKey) };
            throw err;
        }
    },

    async transition(orgId, id, { fromStatuses, patch = {}, incrementAttempts = false }) {
        const { sets, params } = buildSet(patch, STEP_FIELDS, STEP_JSON);
        if (incrementAttempts) sets.push("attempts = attempts + 1");
        if (!sets.length) return null;
        let where = "organization_id = ? AND id = ?";
        params.push(Number(orgId), Number(id));
        if (Array.isArray(fromStatuses) && fromStatuses.length) {
            where += ` AND status IN (${placeholders(fromStatuses)})`;
            params.push(...fromStatuses);
        }
        const result = await execute(`UPDATE ${stepTable} SET ${sets.join(", ")} WHERE ${where}`, params);
        if (!result.affectedRows) return null;
        return this.findById(orgId, id);
    },

    async claim(orgId, id, now = new Date()) {
        return this.transition(orgId, id, {
            fromStatuses: [STEP_STATUS.SCHEDULED],
            patch: { status: STEP_STATUS.EXECUTING, locked_at: now },
            incrementAttempts: true,
        });
    },

    async cancelOpen(orgId, enrollmentId, reason, { statuses = [STEP_STATUS.SCHEDULED, STEP_STATUS.PENDING_APPROVAL], exceptId = null } = {}) {
        const params = [STEP_STATUS.CANCELLED, String(reason || "Cancelled").slice(0, 255), new Date(), Number(orgId), Number(enrollmentId), ...statuses];
        let sql = `UPDATE ${stepTable}
                   SET status = ?, decision_reason = ?, completed_at = ?
                   WHERE organization_id = ? AND enrollment_id = ? AND status IN (${placeholders(statuses)})`;
        if (exceptId) {
            sql += " AND id <> ?";
            params.push(Number(exceptId));
        }
        const result = await execute(sql, params);
        return Number(result?.affectedRows || 0);
    },

    async listByEnrollment(orgId, enrollmentId) {
        const rows = await query(
            `SELECT ${aseCadenceStepSchema.columns} FROM ${stepTable}
             WHERE organization_id = ? AND enrollment_id = ? ORDER BY due_at ASC, id ASC LIMIT 200`,
            [Number(orgId), Number(enrollmentId)]
        );
        return rows.map(toStep);
    },

    async findNextOpen(orgId, enrollmentId) {
        const rows = await query(
            `SELECT ${aseCadenceStepSchema.columns} FROM ${stepTable}
             WHERE organization_id = ? AND enrollment_id = ? AND status IN ('SCHEDULED', 'PENDING_APPROVAL', 'EXECUTING', 'AWAITING_OUTCOME')
             ORDER BY due_at ASC, id ASC LIMIT 1`,
            [Number(orgId), Number(enrollmentId)]
        );
        return toStep(rows[0]);
    },

    async nextDueByEnrollments(orgId, enrollmentIds) {
        const ids = [...new Set((enrollmentIds || []).map(Number).filter(Boolean))].slice(0, 500);
        if (!ids.length) return new Map();
        const rows = await query(
            `SELECT enrollment_id, MIN(due_at) AS next_due FROM ${stepTable}
             WHERE organization_id = ? AND enrollment_id IN (${placeholders(ids)}) AND status IN ('SCHEDULED', 'PENDING_APPROVAL')
             GROUP BY enrollment_id`,
            [Number(orgId), ...ids]
        );
        return new Map(rows.map((r) => [Number(r.enrollment_id), r.next_due]));
    },

    async findDue(now = new Date(), limit = 200) {
        const rows = await query(
            `SELECT id, organization_id, due_at FROM ${stepTable}
             WHERE status = 'SCHEDULED' AND due_at <= ?
             ORDER BY due_at ASC LIMIT ?`,
            [now, clampLimit(limit, 200, 1000)]
        );
        return rows.map((r) => ({ id: Number(r.id), organization_id: Number(r.organization_id), due_at: r.due_at }));
    },

    async findStale(status, olderThan, limit = 100) {
        const column = status === STEP_STATUS.EXECUTING ? "locked_at" : "executed_at";
        const rows = await query(
            `SELECT ${aseCadenceStepSchema.columns} FROM ${stepTable}
             WHERE status = ? AND ${column} IS NOT NULL AND ${column} < ?
             ORDER BY ${column} ASC LIMIT ?`,
            [status, olderThan, clampLimit(limit, 100, 500)]
        );
        return rows.map(toStep);
    },

    async listQueue(orgId, { statuses = null, actions = null, purposes = null, channelStates = null, enrollmentStatuses = null, leadSuppressed = false, latestOnly = false, dueBefore = null, leadId = null, limit = 50, offset = 0 } = {}) {
        const where = ["s.organization_id = ?"];
        const params = [Number(orgId)];
        const addIn = (column, values) => {
            if (!Array.isArray(values) || !values.length) return;
            where.push(`${column} IN (${placeholders(values)})`);
            params.push(...values);
        };
        addIn("s.status", statuses);
        addIn("s.action", actions);
        addIn("s.purpose", purposes);
        addIn("s.channel_state", channelStates);
        addIn("e.status", enrollmentStatuses);
        if (leadSuppressed) where.push("l.do_not_contact = 1");
        if (latestOnly) where.push(`s.id = (SELECT MAX(s2.id) FROM ${stepTable} s2 WHERE s2.enrollment_id = s.enrollment_id)`);
        if (dueBefore) {
            where.push("s.due_at <= ?");
            params.push(dueBefore);
        }
        if (leadId) {
            where.push("s.lead_id = ?");
            params.push(Number(leadId));
        }
        const pageSize = clampLimit(limit, 50, 200);
        const rows = await query(
            `SELECT s.id, s.organization_id, s.enrollment_id, s.lead_id, s.step_key, s.action, s.purpose, s.status, s.channel_state,
                    s.due_at, s.decided_by, s.decision_reason, s.call_id, s.attempts, s.executed_at, s.completed_at, s.created_at, s.updated_at,
                    e.status AS enrollment_status, e.stage AS enrollment_stage, e.call_attempts, e.email_attempts, e.latest_outcome,
                    l.name AS lead_name, l.company AS lead_company, l.email AS lead_email
             FROM ${stepTable} s
             JOIN ${enrollmentTable} e ON e.id = s.enrollment_id
             LEFT JOIN leads l ON l.id = s.lead_id AND l.organization_id = s.organization_id
             WHERE ${where.join(" AND ")}
             ORDER BY s.due_at ASC, s.id ASC
             LIMIT ${pageSize} OFFSET ${Math.max(Number(offset) || 0, 0)}`,
            params
        );
        return rows.map(toStep);
    },

    async listRecentEmailBodies(orgId, enrollmentId, limit = 5) {
        const rows = await query(
            `SELECT draft FROM ${stepTable}
             WHERE organization_id = ? AND enrollment_id = ? AND action = 'EMAIL' AND status = 'DONE' AND draft IS NOT NULL
             ORDER BY completed_at DESC LIMIT ?`,
            [Number(orgId), Number(enrollmentId), clampLimit(limit, 5, 20)]
        );
        return rows.map((r) => parseJson(r.draft, {})?.text).filter(Boolean);
    },
};

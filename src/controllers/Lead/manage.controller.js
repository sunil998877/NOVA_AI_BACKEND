import { asyncHandler } from "../../utils/asyncHandler.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Callback } from "../../models/callback.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { env } from "../../config/env.js";
import { describeLeadApiKey, publicApiBase, rotateLeadApiKey, maskApiKey } from "../../services/leads/leadApiCredential.service.js";
import { MAX_BATCH } from "../../services/leads/leadIntake.service.js";
import { aseScheduler } from "../../services/ase/scheduler.service.js";
import { OrchestratorService } from "../../services/ase/orchestrator.service.js";
import { query } from "../../config/db.js";
import { draftCompanyPersonalizedEmail } from "../../services/ase/leadEmailDrafter.service.js";

const TERMINAL_STATES = new Set(["CLOSED_WON", "CLOSED_LOST", "CLOSED_UNQUALIFIED", "SUPPRESSED_DNC"]);

export const listLeads = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    await Callback.ensureHandoffQueue(orgId).catch(() => {});

    const { items, total } = await Lead.list(orgId, {
        q: String(req.query.q || ""),
        source: String(req.query.source || ""),
        status: String(req.query.status || ""),
        priority: req.query.priority !== undefined ? req.query.priority : null,
        assigned_rep_id: req.query.assigned_rep_id ? Number(req.query.assigned_rep_id) : null,
        skip: (page - 1) * limit,
        limit,
    });

    return res.status(200).json({ data: items, pagination: { page, limit, total } });
});

export const getLead = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    let lead = await Lead.findById(req.params.id, orgId);
    if (!lead) {
        lead = await Lead.findById(req.params.id);
    }
    if (!lead) {
        const callbackRows = await query(
            `SELECT c.*, u.fullName as rep_name FROM callbacks c LEFT JOIN users u ON c.assigned_rep_id = u.id WHERE c.lead_id = ? OR c.id = ? LIMIT 1`,
            [req.params.id, req.params.id]
        );
        if (callbackRows && callbackRows.length > 0) {
            const cb = callbackRows[0];
            lead = {
                id: Number(req.params.id),
                name: "Prospective Client",
                company: null,
                phone: null,
                email: null,
                status: "CALLBACK_SCHEDULED",
                priority: 50,
                health: "GREEN",
                callback: {
                    id: cb.id,
                    due_at: cb.due_at,
                    status: cb.status,
                    notes: cb.notes,
                    rep_name: cb.rep_name,
                },
            };
        }
    }
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const timeline = await LeadEvent.listByLead(orgId, lead.id, 100).catch(() => []);
    return res.status(200).json({ data: { lead, timeline: timeline || [] } });
});

export const updateLead = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const lead = await Lead.findById(req.params.id, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const updates = { ...req.body };
    const oldStatus = lead.status;
    const newStatus = updates.status;

    if (updates.metadata && typeof updates.metadata === "object") {
        updates.metadata = {
            ...(lead.metadata || {}),
            ...updates.metadata,
        };
    }

    if (updates.do_not_contact) {
        updates.status = "SUPPRESSED_DNC";
        updates.next_action = null;
        updates.next_action_time = null;
        await Suppression.add(orgId, "EMAIL", lead.email, "Marked DNC via UI");
        if (lead.phone) await Suppression.add(orgId, "PHONE", lead.phone, "Marked DNC via UI");
    } else if (newStatus && TERMINAL_STATES.has(newStatus)) {
        updates.next_action = null;
        updates.next_action_time = null;
    }

    const updated = await Lead.updateById(lead.id, updates, orgId);

    if (newStatus && newStatus !== oldStatus) {
        await LeadEvent.create({
            organization_id: orgId,
            lead_id: lead.id,
            user_id: req.user.id,
            channel: "SYSTEM",
            event_type: "LEAD_STATE_CHANGED",
            status: newStatus,
            payload: { from: oldStatus, to: newStatus, notes: updates.notes || null },
        });
    }

    if (updates.assigned_rep_id && updates.assigned_rep_id !== lead.assigned_rep_id) {
        await LeadEvent.create({
            organization_id: orgId,
            lead_id: lead.id,
            user_id: req.user.id,
            channel: "SYSTEM",
            event_type: "REP_ASSIGNED",
            payload: { repId: updates.assigned_rep_id },
        });
    }

    return res.status(200).json({ data: updated });
});

export const leadStats = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const byStatus = await Lead.countByStatus(orgId);
    const bySource = await Lead.countBySource(orgId);
    const callbackStats = await Callback.countStats(orgId);
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

    return res.status(200).json({
        data: {
            total,
            byStatus,
            bySource,
            callbacks: callbackStats,
        },
    });
});

export const deleteLead = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const ok = await Lead.deleteById(req.params.id, orgId);
    if (!ok) return res.status(404).json({ error: "Lead not found" });
    return res.status(200).json({ data: { deleted: true } });
});

export const getApiCaptureConfig = asyncHandler(async (req, res) => {
    const credential = await describeLeadApiKey();
    const organizationId = Number(req.user.organization_id || credential.organizationId || 1);
    if (credential.organizationId !== organizationId) {
        return res.status(403).json({ error: "Lead API credentials belong to a different organization" });
    }
    return res.status(200).json({
        data: {
            apiKey: credential.apiKey,
            apiKeyPrefix: credential.apiKeyPrefix,
            apiKeyMasked: credential.apiKeyMasked,
            apiKeyConfigured: credential.apiKeyConfigured,
            keyStoredAsHash: credential.keyStoredAsHash,
            rotatedAt: credential.rotatedAt,
            endpoint: "/api/leads",
            webhookEndpoint: "/api/leads/webhook",
            publicBaseUrl: publicApiBase(req),
            deployedBaseUrl: env.publicApiUrl || null,
            organizationId,
            maxBatch: MAX_BATCH,
            authHeader: "x-api-key",
            devProxy: "The Vite dev server proxies /api to the backend. External webhook senders must use publicBaseUrl.",
        },
    });
});

export const rotateApiCaptureKey = asyncHandler(async (req, res) => {
    const credential = await describeLeadApiKey();
    const organizationId = Number(req.user.organization_id || 0);
    if (!organizationId || credential.organizationId !== organizationId) {
        return res.status(403).json({ error: "Only the API key organization can rotate this key" });
    }
    const rotated = await rotateLeadApiKey();
    return res.status(200).json({
        data: {
            apiKey: rotated.apiKey,
            apiKeyPrefix: rotated.apiKeyPrefix,
            apiKeyMasked: rotated.apiKeyMasked || maskApiKey(rotated.apiKey),
            rotatedAt: rotated.rotatedAt,
            organizationId: rotated.organizationId,
        },
    });
});

export const executeLeadAction = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    let lead = await Lead.findById(req.params.id, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (lead.do_not_contact) return res.status(400).json({ error: "Lead is suppressed (Do Not Contact)" });
    if (TERMINAL_STATES.has(lead.status)) return res.status(400).json({ error: "Lead is in a terminal state" });

    const startedAt = Date.now();
    const validActions = new Set(["EMAIL", "CALL"]);
    let action = validActions.has(lead.next_action) ? lead.next_action : null;

    if (!action) {
        const decision = await OrchestratorService.evaluateNextAction(lead);
        action = decision?.action && validActions.has(decision.action) ? decision.action : null;
        if (!action) {
            const counters = typeof lead.attempt_counters === "string"
                ? JSON.parse(lead.attempt_counters || "{}")
                : (lead.attempt_counters || { email: 0, voice: 0, total: 0 });
            if (lead.email && counters.email < 3 && lead.email_consent?.status !== "DENIED") {
                action = "EMAIL";
            } else if (lead.phone && counters.voice < 2 && lead.voice_consent?.status !== "DENIED") {
                action = "CALL";
            }
        }
        if (!action) {
            return res.status(400).json({ error: "No eligible action to execute" });
        }
    }

    lead = await Lead.updateById(lead.id, {
        next_action: action,
        next_action_time: new Date(),
    }, orgId);

    const result = await aseScheduler.processLeadAction(lead, { force: true });
    const updated = await Lead.findById(lead.id, orgId);
    const elapsedMs = Date.now() - startedAt;

    if (!result?.executed) {
        return res.status(400).json({
            error: result?.reason || "Execution did not complete",
            data: { lead: updated, executed: false, elapsedMs },
        });
    }

    console.log(`[ASE] Execute Now completed for lead ${lead.id} action=${result.action} in ${elapsedMs}ms`);
    return res.status(200).json({
        data: { lead: updated, executed: true, action: result.action, elapsedMs },
    });
});

export const listTeamReps = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const rows = await query(
        `SELECT id, fullName, email, role
         FROM users
         WHERE organization_id = ?
         ORDER BY (role = 'SALESPERSON' OR role = 'SALES_MANAGER') DESC, fullName ASC`,
        [orgId]
    );
    return res.status(200).json({ data: rows });
});

export const draftLeadEmail = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const lead = await Lead.findById(req.params.id, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const drafted = await draftCompanyPersonalizedEmail(lead, req.body || {});
    const existing = lead.metadata || {};
    const metadata = {
        ...existing,
        company_research: existing.company_research || drafted.research,
        outreach_status: "ready",
        outreach_email: {
            subject: drafted.subject,
            text: drafted.text,
            html: drafted.html,
            written_at: new Date().toISOString(),
        },
    };

    const updated = await Lead.updateById(lead.id, { metadata }, orgId);

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        user_id: req.user.id || null,
        channel: "EMAIL",
        event_type: "EMAIL_DRAFTED",
        status: "COMPLETED",
        payload: {
            subject: drafted.subject,
            company: drafted.research?.company || lead.company,
        },
    });

    return res.status(200).json({ data: { lead: updated, email: metadata.outreach_email } });
});


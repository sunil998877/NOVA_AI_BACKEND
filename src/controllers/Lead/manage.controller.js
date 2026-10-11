import { asyncHandler } from "../../utils/asyncHandler.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Callback } from "../../models/callback.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { env } from "../../config/env.js";

const TERMINAL_STATES = new Set(["CLOSED_WON", "CLOSED_LOST", "CLOSED_UNQUALIFIED", "SUPPRESSED_DNC"]);

export const listLeads = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

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
    const lead = await Lead.findById(req.params.id, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const timeline = await LeadEvent.listByLead(orgId, lead.id, 100);
    return res.status(200).json({ data: { lead, timeline } });
});

export const updateLead = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const lead = await Lead.findById(req.params.id, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const updates = { ...req.body };
    const oldStatus = lead.status;
    const newStatus = updates.status;

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
    return res.status(200).json({
        data: {
            apiKey: env.leadsApiKey || "ase-lead-key-nova-2026",
            endpoint: "/api/leads",
            webhookEndpoint: "/api/leads/webhook",
            engineWebhookEndpoint: "/api/engine/leads/webhook",
            organizationId: Number(req.user.organization_id || 1),
        },
    });
});


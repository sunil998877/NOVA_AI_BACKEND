import { asyncHandler } from "../../utils/asyncHandler.js";
import { Callback } from "../../models/callback.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";

export const listCallbacks = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const { status, assigned_rep_id, overdue, limit, page } = req.query;
    const p = Math.max(Number(page) || 1, 1);
    const l = Math.min(Math.max(Number(limit) || 50, 1), 200);

    await Callback.ensureHandoffQueue(orgId);

    const items = await Callback.list(orgId, {
        status: status ? String(status) : "",
        assigned_rep_id: assigned_rep_id ? Number(assigned_rep_id) : null,
        overdue: overdue === "true",
        limit: l,
        skip: (p - 1) * l,
    });

    const stats = await Callback.countStats(orgId);
    return res.status(200).json({ data: items, stats });
});

export const getCallback = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const item = await Callback.findById(orgId, req.params.id);
    if (!item) return res.status(404).json({ error: "Callback not found" });
    return res.status(200).json({ data: item });
});

export const updateCallback = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const existing = await Callback.findById(orgId, req.params.id);
    if (!existing) return res.status(404).json({ error: "Callback not found" });

    const updates = {};
    if (req.body.status) updates.status = req.body.status;
    if (req.body.assigned_rep_id !== undefined) updates.assigned_rep_id = req.body.assigned_rep_id;
    if (req.body.due_at) updates.due_at = req.body.due_at;
    if (req.body.notes) updates.notes = req.body.notes;

    if (req.body.status === "COMPLETED") {
        updates.completed_at = new Date();
    }

    const updated = await Callback.updateById(orgId, req.params.id, updates);

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: existing.lead_id,
        user_id: req.user.id,
        channel: "SYSTEM",
        event_type: updates.status === "COMPLETED" ? "CALLBACK_COMPLETED" : "CALLBACK_UPDATED",
        status: updates.status || existing.status,
        payload: { callbackId: existing.id, updates },
    });

    if (req.body.status === "COMPLETED" && req.body.leadDisposition) {
        let finalStatus = req.body.leadStatus || "CONTACTED";
        if (req.body.leadDisposition === "closed_won" || req.body.leadDisposition === "deal_won") {
            finalStatus = "CLOSED_WON";
        } else if (req.body.leadDisposition === "not_interested") {
            finalStatus = "CLOSED_LOST";
        } else if (req.body.nextCallbackDue) {
            finalStatus = "CALLBACK_SCHEDULED";
        }

        await Lead.updateById(
            existing.lead_id,
            {
                disposition: req.body.leadDisposition,
                status: finalStatus,
                last_contacted_at: new Date(),
                callback_due: req.body.nextCallbackDue ? new Date(req.body.nextCallbackDue) : null,
            },
            orgId
        );
    }

    if (req.body.nextCallbackDue) {
        await Callback.create({
            organization_id: orgId,
            lead_id: existing.lead_id,
            assigned_rep_id: req.body.assigned_rep_id || existing.assigned_rep_id || req.user.id,
            due_at: new Date(req.body.nextCallbackDue),
            status: "OPEN",
            notes: req.body.nextCallbackNotes || `Follow-up scheduled after call with ${existing.lead_name || "lead"}.`,
        });
    }

    return res.status(200).json({ data: updated });
});

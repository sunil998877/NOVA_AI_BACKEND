import { asyncHandler } from "../../utils/asyncHandler.js";
import { Callback } from "../../models/callback.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { eventBus } from "../../services/ase/eventBus.service.js";
import { routeUnassignedHandoffs } from "../../services/ase/routingAssign.service.js";
import {
    getCallbackCallStatus,
    notesForComplete,
} from "../../services/ase/callbackCall.service.js";
import { startCallbackQueueClickToCall } from "../../services/ase/callbackClickToCall.service.js";

function httpError(err, res) {
    return res.status(err.status || 500).json({ error: err.message });
}

export const listCallbacks = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const { status, assigned_rep_id, overdue, limit, page } = req.query;
    const p = Math.max(Number(page) || 1, 1);
    const l = Math.min(Math.max(Number(limit) || 50, 1), 200);

    await routeUnassignedHandoffs(orgId).catch(() => ({ assigned: 0 }));
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

export const startCallbackVoiceCall = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    try {
        const result = await startCallbackQueueClickToCall(orgId, req.params.id, req.user, {
            primaryPhone: req.body?.repPhone || req.body?.primaryPhone || "",
        });
        return res.status(200).json({
            success: true,
            data: {
                callId: result.call?.id || null,
                callbackId: Number(req.params.id),
                humanPhone: result.humanPhone || result.primaryPhone,
                leadPhone: result.leadPhone,
                from: result.from,
                reused: Boolean(result.reused),
                status: result.session?.state || result.call?.provider_status || "calling_you",
                mode: "click_to_call",
            },
        });
    } catch (err) {
        return httpError(err, res);
    }
});

export const getCallbackVoiceCall = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    try {
        const result = await getCallbackCallStatus(orgId, req.params.id);
        return res.status(200).json({
            success: true,
            data: {
                callId: result.call?.id || null,
                callbackId: Number(req.params.id),
                telHref: result.telHref,
                status: result.status,
                transcript: result.transcript,
                notes: result.notes,
                recordingUrl: result.recordingUrl,
                suggestedOutcome: result.suggestedOutcome,
                durationSec: result.durationSec,
                isAnswered: result.isAnswered,
                completed: result.completed,
            },
        });
    } catch (err) {
        return httpError(err, res);
    }
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
    if (req.body.call_id) updates.call_id = Number(req.body.call_id);
    if (req.body.actual_outcome || req.body.leadDisposition) {
        updates.actual_outcome = req.body.actual_outcome || req.body.leadDisposition;
    }
    if (req.body.follow_up_action) updates.follow_up_action = req.body.follow_up_action;

    const isCompleting = req.body.status === "COMPLETED";

    if (isCompleting) {
        const conversationNotes = await notesForComplete(orgId, existing.id, req.body.notes);
        if (conversationNotes && !updates.notes) updates.notes = conversationNotes;
        if (!updates.actual_outcome) {
            const convo = await getCallbackCallStatus(orgId, existing.id).catch(() => null);
            if (convo?.suggestedOutcome) updates.actual_outcome = convo.suggestedOutcome;
        }
        updates.completed_at = new Date();
        const nowMs = Date.now();
        const dueMs = existing.due_at ? new Date(existing.due_at).getTime() : nowMs;
        const slaStatus = nowMs <= dueMs ? "MET" : "BREACHED";
        updates.sla_status = slaStatus;
        if (slaStatus === "BREACHED" && !existing.sla_breached_at) {
            updates.sla_breached_at = new Date();
        }
    }

    const updated = await Callback.updateById(orgId, req.params.id, updates);

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: existing.lead_id,
        user_id: req.user.id,
        channel: "SYSTEM",
        event_type: isCompleting ? "CALLBACK_COMPLETED" : "CALLBACK_UPDATED",
        status: updates.status || existing.status,
        payload: {
            callbackId: existing.id,
            callId: existing.call_id || updates.call_id,
            slaStatus: updates.sla_status || existing.sla_status,
            actualOutcome: updates.actual_outcome || existing.actual_outcome,
            notes: updates.notes,
            updates,
        },
    });

    if (isCompleting) {
        await eventBus.publish("CallbackCompleted", {
            organization_id: orgId,
            lead_id: existing.lead_id,
            channel: "SYSTEM",
            status: "COMPLETED",
            callback_id: existing.id,
            call_id: existing.call_id || updates.call_id,
            sla_status: updates.sla_status,
            actual_outcome: updates.actual_outcome,
        });
    }

    if (isCompleting && (req.body.leadDisposition || req.body.leadStatus)) {
        let finalStatus = req.body.leadStatus || "CONTACTED";
        const disp = req.body.leadDisposition || "";
        if (disp === "closed_won" || disp === "deal_won") {
            finalStatus = "CLOSED_WON";
        } else if (disp === "not_interested" || disp === "closed_lost" || disp === "connected_not_interested") {
            finalStatus = "CLOSED_LOST";
        } else if (disp === "do_not_call" || disp === "dnc") {
            finalStatus = "SUPPRESSED_DNC";
        } else if (disp === "connected_interested" || disp === "interested" || disp === "qualified") {
            finalStatus = "INTERESTED";
        } else if (disp === "callback_requested" || disp === "human_handoff" || req.body.nextCallbackDue) {
            finalStatus = "CALLBACK_SCHEDULED";
        } else if (disp === "no_answer" || disp === "busy" || disp === "invalid_number") {
            finalStatus = existing.lead_status || "CONTACTED";
        }

        await Lead.updateById(
            existing.lead_id,
            {
                disposition: disp || undefined,
                status: finalStatus,
                last_contacted_at: new Date(),
                callback_due: req.body.nextCallbackDue ? new Date(req.body.nextCallbackDue) : null,
                next_action: req.body.nextCallbackDue ? "REP_CALLBACK" : null,
            },
            orgId
        );
    }

    if (req.body.nextCallbackDue) {
        await Callback.create({
            organization_id: orgId,
            lead_id: existing.lead_id,
            call_id: existing.call_id || updates.call_id,
            assigned_rep_id: req.body.assigned_rep_id || existing.assigned_rep_id || req.user.id,
            due_at: new Date(req.body.nextCallbackDue),
            requested_at: new Date(),
            status: "SCHEDULED",
            notes: req.body.nextCallbackNotes || `Follow-up scheduled after call with ${existing.lead_name || "lead"}.`,
        });
    }

    return res.status(200).json({ data: updated });
});

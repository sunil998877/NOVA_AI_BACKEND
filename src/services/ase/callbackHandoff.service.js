import { Lead } from "../../models/lead.model.js";
import { Callback } from "../../models/callback.model.js";
import { AseExecution } from "../../models/ase-execution.model.js";
import { ASE_OUTCOMES, classifyProspectSpeech, extractCallTranscript } from "./outcomeNormalizer.service.js";
import { transitionLeadState } from "./leadStateMachine.js";
import { eventBus } from "./eventBus.service.js";
import { followUpEngine } from "../followup/followUpEngine.service.js";
import { applyHotLeadAssignment } from "./routingAssign.service.js";
import { HANDOFF_STATUSES, setHandoffStatus } from "./handoffStatus.service.js";

const CALLBACK_SLA_MS = 30 * 60 * 1000;

export function isAlreadyHumanHandoff(lead = {}) {
    const status = String(lead.status || "").toUpperCase();
    const next = String(lead.next_action || "").toUpperCase();
    if (status === "WARM_TRANSFER" || status === "HANDED_OFF") return true;
    if (status === "CALLBACK_SCHEDULED" && next === "REP_CALLBACK") return true;
    return false;
}

export async function queueCallbackHandoff(lead, rawData = {}, extras = {}) {
    if (!lead?.id) return { queued: false, reason: "NO_LEAD" };
    if (isAlreadyHumanHandoff(lead) && String(lead.status || "").toUpperCase() !== "WARM_TRANSFER") {
        return { queued: false, reason: "ALREADY_HANDED_OFF", lead };
    }

    const orgId = Number(lead.organization_id || rawData.organization_id || 1);
    const outcome = extras.outcome || rawData.outcome || ASE_OUTCOMES.INTERESTED;
    const currentStatus = String(extras.fromStatus || lead.status || "").toUpperCase();
    const missed = Boolean(extras.failedTransfer || extras.missedTransfer);
    const eventName = extras.eventName
        || (missed && currentStatus === "WARM_TRANSFER"
            ? "TRANSFER_FAILED"
            : missed || outcome === ASE_OUTCOMES.CALLBACK
                ? "CALLBACK_REQUESTED"
                : "INTEREST_DETECTED");
    const transition = transitionLeadState(lead.status, eventName, { outcome, rawData });

    const routed = await applyHotLeadAssignment(lead, {
        organizationId: orgId,
        reason: extras.reason || (outcome === ASE_OUTCOMES.CALLBACK ? "callback" : "interest"),
    }).catch(() => ({ assignedRepId: lead.assigned_rep_id || null, lead }));
    const assignedRepId = extras.assignedRepId || routed.assignedRepId || lead.assigned_rep_id || null;
    lead = routed.lead || lead;

    const dueAt = extras.dueAt ? new Date(extras.dueAt) : new Date(Date.now() + CALLBACK_SLA_MS);
    const callId = rawData.callId ? Number(rawData.callId) : (rawData.call_id ? Number(rawData.call_id) : null);
    const callback = await Callback.create({
        organization_id: orgId,
        lead_id: lead.id,
        call_id: callId,
        assigned_rep_id: assignedRepId,
        due_at: dueAt,
        requested_at: new Date(),
        status: "OPEN",
        notes: extras.notes || "Automated handoff: Prospect showed interest / requested callback.",
    });

    await followUpEngine.handleHumanHandoff(lead.id, orgId, "Callback queued for a sales rep").catch(() => {});
    const meetingRequested = Boolean(
        extras.meetingRequested
        ?? rawData.meetingRequested
        ?? classifyProspectSpeech(extractCallTranscript(rawData)).meetingRequested
    );
    if (meetingRequested) {
        const { requestMeeting } = await import("./meetingBooking.service.js");
        await requestMeeting(orgId, lead.id, {
            source: rawData.channel || "VOICE",
            sourceRef: callId ? `call_${callId}` : null,
            repUserId: assignedRepId,
            preferredText: "Prospect asked to book a meeting on the call; rep to confirm date, time and timezone.",
        }).catch((err) => console.warn("[Handoff] meeting request failed:", err.message));
    } else {
        await setHandoffStatus(lead, HANDOFF_STATUSES.CALLBACK_PENDING, {
            orgId,
            source: rawData.channel || "VOICE",
            reason: extras.reason || (outcome === ASE_OUTCOMES.CALLBACK ? "Prospect requested a callback" : "Prospect showed interest"),
            callId,
        }).catch((err) => console.warn("[Handoff] status update failed:", err.message));
    }
    await AseExecution.cancelOpenForLead(orgId, lead.id, "Human callback queued — no second bot call").catch(() => 0);

    const updated = await Lead.updateById(
        lead.id,
        {
            status: transition.nextState,
            assigned_rep_id: assignedRepId,
            callback_due: dueAt,
            health: "AMBER",
            next_action: "REP_CALLBACK",
            next_action_time: null,
        },
        orgId
    );

    await eventBus.publish("ChannelOutcomeReceived", {
        organization_id: orgId,
        lead_id: lead.id,
        channel: rawData.channel || "VOICE",
        outcome,
        rawData,
    });

    await eventBus.publish("CallbackCreated", {
        organization_id: orgId,
        lead_id: lead.id,
        channel: "SYSTEM",
        status: updated?.status || transition.nextState,
        callback_id: callback.id,
        due_at: dueAt,
        call_id: callback.call_id,
        reason: extras.reason || null,
        rawData,
    });

    return {
        queued: true,
        action: "CALLBACK",
        callback,
        lead: updated || lead,
        dueAt,
        assignedRepId,
        nextState: updated?.status || "CALLBACK_SCHEDULED",
    };
}

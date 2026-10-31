import { AseApproval } from "../../models/ase-approval.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { APPROVAL_STATUSES } from "../../schema/ase-approval.schema.js";

const OUTBOUND = new Set(["EMAIL", "CALL"]);
export const HOLD_DURATION_MS = 24 * 60 * 60 * 1000;
export const OUTREACH_HOLD_REASON = "Lead outreach is on hold";

export function nextHoldUntil(from = new Date()) {
    return new Date(from.getTime() + HOLD_DURATION_MS);
}

export function readOutreachHold(lead) {
    const hold = lead?.metadata?.outreach_hold;
    if (!hold || typeof hold !== "object") return null;
    if (hold.held === true || hold.held === 1 || hold.held === "1") return hold;
    return null;
}

export function isLeadOnHold(lead) {
    return Boolean(readOutreachHold(lead));
}

export function buildHoldSnapshot(lead, now = new Date()) {
    return {
        held: true,
        heldAt: now.toISOString(),
        previousNextAction: lead?.next_action || null,
        previousNextActionTime: lead?.next_action_time
            ? new Date(lead.next_action_time).toISOString()
            : null,
    };
}

export function restoreTimeFromHold(snapshot, now = new Date()) {
    const prev = snapshot?.previousNextActionTime;
    if (!prev) return now;
    const date = new Date(prev);
    if (Number.isNaN(date.getTime())) return now;
    if (date.getTime() > now.getTime() + 15 * 1000) return date;
    return now;
}

function resolveAction(lead, actionType) {
    const next = String(actionType || lead?.next_action || "").toUpperCase();
    return OUTBOUND.has(next) ? next : null;
}

export async function enqueuePendingApproval({
    organizationId,
    leadId,
    action,
    payload = null,
}) {
    const orgId = Number(organizationId || 1);
    const type = String(action || "").toUpperCase();
    if (!OUTBOUND.has(type)) {
        return { created: false, approval: null, reason: `Action ${type} does not need approval` };
    }

    const result = await AseApproval.createPending({
        organization_id: orgId,
        lead_id: Number(leadId),
        action_type: type,
        payload,
    });

    if (result.created && result.approval) {
        await LeadEvent.create({
            organization_id: orgId,
            lead_id: Number(leadId),
            channel: type === "CALL" ? "VOICE" : "EMAIL",
            event_type: "APPROVAL_QUEUED",
            status: APPROVAL_STATUSES.PENDING,
            payload: { approvalId: result.approval.id, action: type, ...(payload || {}) },
            idempotency_key: `approval_queued_${orgId}_${leadId}_${type}_${result.approval.id}`,
        }).catch(() => {});
    }

    return result;
}

export async function getLeadApproval(orgId, leadId) {
    return AseApproval.findLatestForLead(orgId, leadId);
}

export async function listApprovals(orgId, filters = {}) {
    return AseApproval.list(orgId, filters);
}

export async function prepareLeadApproval(orgId, leadId, userId, { actionType = null } = {}) {
    const lead = await Lead.findById(leadId, orgId);
    if (!lead) {
        throw Object.assign(new Error("Lead not found"), { status: 404 });
    }
    if (lead.do_not_contact) {
        throw Object.assign(new Error("Lead is suppressed (Do Not Contact)"), { status: 400 });
    }

    const action = resolveAction(lead, actionType);
    if (!action) {
        throw Object.assign(new Error("No EMAIL or CALL action to approve"), { status: 400 });
    }

    const queued = await enqueuePendingApproval({
        organizationId: orgId,
        leadId: lead.id,
        action,
        payload: { source: "human_approve" },
    });
    if (!queued.approval) {
        throw Object.assign(new Error("Could not queue approval"), { status: 400 });
    }

    const approval = queued.approval.status === APPROVAL_STATUSES.PENDING
        ? await AseApproval.review(orgId, queued.approval.id, {
            status: APPROVAL_STATUSES.APPROVED,
            reviewedBy: userId,
        })
        : queued.approval;

    const updatedLead = await Lead.updateById(
        lead.id,
        { next_action: action, next_action_time: new Date() },
        orgId
    );

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        user_id: userId || null,
        channel: action === "CALL" ? "VOICE" : "EMAIL",
        event_type: "APPROVAL_APPROVED",
        status: APPROVAL_STATUSES.APPROVED,
        payload: { approvalId: approval.id, action },
    }).catch(() => {});

    return { approval, lead: updatedLead || lead, action };
}

export async function holdLeadApproval(orgId, leadId, userId) {
    const lead = await Lead.findById(leadId, orgId);
    if (!lead) {
        throw Object.assign(new Error("Lead not found"), { status: 404 });
    }
    if (isLeadOnHold(lead)) {
        const existing = readOutreachHold(lead);
        return {
            held: true,
            alreadyHeld: true,
            approvalId: null,
            heldUntil: existing?.heldAt || null,
            lead,
        };
    }

    const action = resolveAction(lead, lead.next_action);
    const pending = action
        ? await AseApproval.findPending(orgId, lead.id, action)
        : await AseApproval.findLatestForLead(orgId, lead.id);

    if (pending?.status === APPROVAL_STATUSES.PENDING) {
        await AseApproval.review(orgId, pending.id, {
            status: APPROVAL_STATUSES.HELD,
            reviewedBy: userId,
        });
    }

    const snapshot = buildHoldSnapshot(lead);
    const metadata = { ...(lead.metadata || {}), outreach_hold: snapshot };
    const updatedLead = await Lead.updateById(
        lead.id,
        { metadata, next_action: lead.next_action || action || "WAIT" },
        orgId
    );

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        user_id: userId || null,
        channel: "SYSTEM",
        event_type: "APPROVAL_HELD",
        status: APPROVAL_STATUSES.HELD,
        payload: {
            approvalId: pending?.id || null,
            action: action || lead.next_action,
            previous_next_action: snapshot.previousNextAction,
            previous_next_action_time: snapshot.previousNextActionTime,
        },
    }).catch(() => {});

    return {
        held: true,
        alreadyHeld: false,
        approvalId: pending?.id || null,
        heldUntil: null,
        lead: updatedLead || lead,
    };
}

export async function unholdLeadApproval(orgId, leadId, userId) {
    const lead = await Lead.findById(leadId, orgId);
    if (!lead) {
        throw Object.assign(new Error("Lead not found"), { status: 404 });
    }
    const snapshot = readOutreachHold(lead);
    if (!snapshot) {
        return { held: false, resumed: false, alreadyResumed: true, lead };
    }

    const now = new Date();
    const restoredTime = restoreTimeFromHold(snapshot, now);
    const restoredAction = snapshot.previousNextAction || lead.next_action || "WAIT";
    const metadata = { ...(lead.metadata || {}) };
    delete metadata.outreach_hold;

    const updatedLead = await Lead.updateById(
        lead.id,
        {
            metadata,
            next_action: restoredAction,
            next_action_time: restoredTime,
        },
        orgId
    );

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        user_id: userId || null,
        channel: "SYSTEM",
        event_type: "HOLD_CLEARED",
        status: "RESUMED",
        payload: {
            action: restoredAction,
            next_action_time: restoredTime.toISOString(),
            previous_next_action_time: snapshot.previousNextActionTime,
        },
    }).catch(() => {});

    return {
        held: false,
        resumed: true,
        alreadyResumed: false,
        lead: updatedLead || lead,
        nextAction: restoredAction,
        nextActionTime: restoredTime.toISOString(),
    };
}

export async function reviewApprovalById(orgId, approvalId, userId, status) {
    const existing = await AseApproval.findById(orgId, approvalId);
    if (!existing) {
        throw Object.assign(new Error("Approval not found"), { status: 404 });
    }
    if (existing.status !== APPROVAL_STATUSES.PENDING) {
        return existing;
    }
    return AseApproval.review(orgId, approvalId, { status, reviewedBy: userId });
}

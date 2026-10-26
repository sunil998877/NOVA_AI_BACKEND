import { AseApproval } from "../../models/ase-approval.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { APPROVAL_STATUSES } from "../../schema/ase-approval.schema.js";

const OUTBOUND = new Set(["EMAIL", "CALL"]);
export const HOLD_DURATION_MS = 24 * 60 * 60 * 1000;

export function nextHoldUntil(from = new Date()) {
    return new Date(from.getTime() + HOLD_DURATION_MS);
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

    const heldUntil = nextHoldUntil();
    const updatedLead = await Lead.updateById(
        lead.id,
        { next_action_time: heldUntil },
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
            held_until: heldUntil.toISOString(),
        },
    }).catch(() => {});

    return {
        held: true,
        approvalId: pending?.id || null,
        heldUntil: heldUntil.toISOString(),
        lead: updatedLead || lead,
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

import { canAutoDispatch, getOperatingMode } from "./operatingMode.service.js";
import { enqueuePendingApproval } from "./approvalQueue.service.js";
import { applyHotLeadAssignment } from "./routingAssign.service.js";

async function assignRepIfMissing(lead) {
    if (lead.assigned_rep_id) return lead;
    try {
        const routed = await applyHotLeadAssignment(lead, { reason: "human_escalation" });
        return routed.lead || lead;
    } catch (err) {
        console.warn("[ASE] Could not auto-assign rep for Human Escalation:", err.message);
        return lead;
    }
}

export async function applyOperatingModeGate(lead, action, options = {}) {
    const orgId = Number(lead?.organization_id || options.organizationId || 1);
    const verdict = await canAutoDispatch(action, {
        organizationId: orgId,
        approved: Boolean(options.approved),
        manual: Boolean(options.manual),
    });

    if (verdict.allowed) {
        return { ...verdict, queued: false };
    }

    let approval = null;
    if (verdict.enqueue) {
        const queued = await enqueuePendingApproval({
            organizationId: orgId,
            leadId: lead.id,
            action,
            payload: {
                source: "scheduler",
                next_action_time: lead.next_action_time || null,
            },
        });
        approval = queued.approval;
    }

    if (verdict.assignRep) {
        await assignRepIfMissing(lead);
    }

    return { ...verdict, queued: Boolean(approval), approval };
}

export async function getOrgOperatingMode(orgId) {
    return getOperatingMode(orgId);
}

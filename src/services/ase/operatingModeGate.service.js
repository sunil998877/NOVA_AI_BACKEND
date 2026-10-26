import { query } from "../../config/db.js";
import { Lead } from "../../models/lead.model.js";
import { canAutoDispatch, getOperatingMode } from "./operatingMode.service.js";
import { enqueuePendingApproval } from "./approvalQueue.service.js";

async function assignRepIfMissing(lead) {
    if (lead.assigned_rep_id) return lead;
    const orgId = Number(lead.organization_id || 1);
    try {
        const reps = await query(
            `SELECT id FROM users
             WHERE organization_id = ?
             ORDER BY (role = 'SALESPERSON' OR role = 'SALES_MANAGER') DESC, id ASC
             LIMIT 1`,
            [orgId]
        );
        if (!reps?.length) return lead;
        return await Lead.updateById(lead.id, { assigned_rep_id: reps[0].id }, orgId) || lead;
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

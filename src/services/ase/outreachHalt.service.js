import { AseExecution } from "../../models/ase-execution.model.js";
import { AseApproval } from "../../models/ase-approval.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Callback } from "../../models/callback.model.js";
import { followUpEngine } from "../followup/followUpEngine.service.js";

export async function haltOutreachForLead(orgId, leadId, reason = "Do not contact") {
    const id = Number(leadId);
    const org = Number(orgId || 1);
    if (!id) return { cancelledExecutions: 0, cancelledApprovals: 0, cancelledCallbacks: 0 };

    const [cancelledExecutions, cancelledApprovals, cancelledCallbacks] = await Promise.all([
        AseExecution.cancelOpenForLead(org, id, reason).catch(() => 0),
        AseApproval.cancelPendingForLead(org, id, reason).catch(() => 0),
        Callback.cancelOpenForLead(org, id, reason).catch(() => 0),
        followUpEngine.handleSuppression(id, org, reason).catch(() => null),
        Lead.updateById(id, { next_action: null, next_action_time: null }, org).catch(() => null),
    ]);

    await LeadEvent.create({
        organization_id: org,
        lead_id: id,
        channel: "SYSTEM",
        event_type: "OUTREACH_HALTED",
        status: "CANCELLED",
        payload: { reason, cancelledExecutions, cancelledApprovals, cancelledCallbacks },
        idempotency_key: `outreach_halted_${org}_${id}_${String(reason).slice(0, 40)}`,
    }).catch(() => {});

    return { cancelledExecutions, cancelledApprovals, cancelledCallbacks };
}

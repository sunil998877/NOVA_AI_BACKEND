import { Lead } from "../../models/lead.model.js";
import { aseScheduler } from "./scheduler.service.js";
import { enqueuePendingApproval } from "./approvalQueue.service.js";
import { executionFlagsForMode, getOperatingMode } from "./operatingMode.service.js";
import { OPERATING_MODES } from "./operatingMode.constants.js";

function httpError(message, status) {
    return Object.assign(new Error(message), { status });
}

export async function startAutonomousCall(orgId, leadId, deps = {}) {
    const LeadModel = deps.Lead || Lead;
    const scheduler = deps.scheduler || aseScheduler;

    if (!leadId) throw httpError("leadId is required", 400);

    let lead = await LeadModel.findById(leadId, orgId);
    if (!lead) throw httpError("Lead not found", 404);
    if (lead.do_not_contact) throw httpError("Lead is suppressed (DNC)", 400);
    if (!lead.phone) throw httpError("Lead has no phone number", 400);

    const digits = String(lead.phone || "").replace(/[^\d]/g, "");
    if (digits.length < 10 || digits.length > 15) {
        throw httpError("Lead phone number is unverified or invalid", 400);
    }

    lead = await LeadModel.updateById(
        lead.id,
        {
            next_action: "CALL",
            next_action_time: new Date(),
            status: "DISPATCH_CALL",
        },
        orgId
    );

    const mode = await getOperatingMode(orgId);
    if (mode === OPERATING_MODES.AI_RECOMMENDED) {
        const queued = await enqueuePendingApproval({
            organizationId: orgId,
            leadId: lead.id,
            action: "CALL",
            payload: { source: "autonomous_call_ui" },
        });
        return {
            lead,
            executed: false,
            queued: true,
            approvalId: queued.approval?.id || null,
            action: "CALL",
            operatingMode: mode,
        };
    }

    const flags = executionFlagsForMode(mode, { humanInitiated: true });
    const result = await scheduler.processLeadAction(lead, flags);
    const updated = await LeadModel.findById(lead.id, orgId);

    return {
        lead: updated,
        executed: Boolean(result?.executed),
        queued: false,
        action: "CALL",
        reason: result?.reason || null,
        operatingMode: mode,
    };
}

import { CadenceEnrollment, CadenceStep } from "../../../models/ase-cadence.model.js";
import { LeadEvent } from "../../../models/lead-event.model.js";
import { ENROLLMENT_STATUS, OPEN_ENROLLMENT_STATUSES, STEP_STATUS } from "./cadence.constants.js";

export async function stopCadenceForLead(orgId, leadId, reason = "Outreach halted", { actor = "SYSTEM", status = ENROLLMENT_STATUS.STOPPED, stage = "STOPPED", flags = null } = {}) {
    const enrollment = await CadenceEnrollment.findOpenByLead(orgId, leadId);
    if (!enrollment) return { stopped: false, cancelledSteps: 0 };
    const now = new Date();
    const updated = await CadenceEnrollment.transition(orgId, enrollment.id, {
        fromStatuses: [...OPEN_ENROLLMENT_STATUSES],
        patch: { status, stage, status_reason: String(reason).slice(0, 255), completed_at: now, last_event_at: now },
        mergeFlags: flags,
    });
    if (!updated) return { stopped: false, cancelledSteps: 0 };
    const cancelledSteps = await CadenceStep.cancelOpen(orgId, enrollment.id, reason, {
        statuses: [STEP_STATUS.SCHEDULED, STEP_STATUS.PENDING_APPROVAL],
    });
    await LeadEvent.create({
        organization_id: Number(orgId),
        lead_id: Number(leadId),
        channel: "SYSTEM",
        event_type: "CADENCE_STOPPED",
        status,
        payload: { enrollmentId: enrollment.id, reason, actor, cancelledSteps },
        idempotency_key: `cadence_stop_${enrollment.id}`,
    }).catch(() => {});
    return { stopped: true, cancelledSteps, enrollment: updated };
}

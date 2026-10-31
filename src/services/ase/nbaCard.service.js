import { FollowUpEnrollment } from "../../models/follow-up-enrollment.model.js";
import { FollowUpTask } from "../../models/follow-up-task.model.js";
import { CadenceEnrollment, CadenceStep } from "../../models/ase-cadence.model.js";
import { OPEN_STEP_STATUSES } from "./cadence/cadence.constants.js";
import { presentNba } from "./nbaPresent.service.js";

export async function loadCadenceStep(lead) {
    if (!lead?.id) return null;
    const orgId = Number(lead.organization_id || 1);

    const enrollment = await CadenceEnrollment.findOpenByLead(orgId, lead.id).catch(() => null);
    if (enrollment) {
        const next = await CadenceStep.findNextOpen(orgId, enrollment.id).catch(() => null)
            || (await CadenceStep.listByEnrollment(orgId, enrollment.id).catch(() => []))
                .find((step) => OPEN_STEP_STATUSES.includes(String(step.status || "").toUpperCase()));
        if (next) {
            return {
                purpose: next.purpose || null,
                action: next.action || null,
                name: next.purpose || next.step_key || next.name || null,
            };
        }
        return { purpose: enrollment.stage || "FIRST_CALL", action: "CALL" };
    }

    const legacy = await FollowUpEnrollment.findActiveByLeadId(lead.id, orgId).catch(() => null);
    if (!legacy) return null;
    const tasks = await FollowUpTask.findByEnrollmentId(legacy.id, orgId).catch(() => []);
    const next = (tasks || []).find((task) => ["SCHEDULED", "PENDING", "PROCESSING"].includes(String(task.status || "").toUpperCase()));
    if (!next) return null;
    const name = next.name && !/^first email$/i.test(next.name) ? next.name : null;
    return {
        name,
        action: next.channel || next.action || "EMAIL",
        stepNumber: Number(next.step_number ?? next.stepNumber) || null,
        dayOffset: Number(next.day_offset ?? next.dayOffset) || null,
    };
}

export async function buildNbaCard(lead, decision, options = {}) {
    const cadenceStep = options.cadenceStep !== undefined
        ? options.cadenceStep
        : await loadCadenceStep(lead).catch(() => null);
    return presentNba({
        lead,
        decision: decision || {},
        cadenceStep,
        operatingMode: options.operatingMode,
        pendingApproval: options.pendingApproval,
        now: options.now,
    });
}

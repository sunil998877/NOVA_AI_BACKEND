import { FollowUpEnrollment } from "../../models/follow-up-enrollment.model.js";
import { FollowUpTask } from "../../models/follow-up-task.model.js";
import { presentNba } from "./nbaPresent.service.js";

const DAY_NAMES = Object.freeze({
    2: "Day 2 follow-up",
    7: "Day 7 follow-up",
    14: "Day 14 follow-up",
    28: "Day 28 follow-up",
    42: "Day 42 follow-up",
});

export async function loadCadenceStep(lead) {
    if (!lead?.id) return null;
    const orgId = Number(lead.organization_id || 1);
    const enrollment = await FollowUpEnrollment.findActiveByLeadId(lead.id, orgId);
    if (!enrollment) return null;
    const tasks = await FollowUpTask.findByEnrollmentId(enrollment.id, orgId).catch(() => []);
    const next = (tasks || []).find((task) => ["SCHEDULED", "PENDING", "PROCESSING"].includes(String(task.status || "").toUpperCase()));
    if (!next) return null;
    const dayOffset = Number(next.day_offset ?? next.dayOffset);
    return {
        name: DAY_NAMES[dayOffset] || next.name || null,
        stepNumber: Number(next.step_number ?? next.stepNumber) || null,
        dayOffset: Number.isFinite(dayOffset) ? dayOffset : null,
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

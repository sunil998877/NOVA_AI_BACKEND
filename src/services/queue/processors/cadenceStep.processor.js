import { executeStep } from "../../ase/cadence/cadence.service.js";

export async function processCadenceStepJob(job) {
    const orgId = Number(job.data?.organizationId || 0);
    const stepId = Number(job.data?.stepId || 0);
    if (!orgId || !stepId) return { executed: false, reason: "invalid_job_payload" };
    return executeStep(orgId, stepId, { source: "queue" });
}

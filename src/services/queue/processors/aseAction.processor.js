export async function processAseActionJob(job) {
    const action = String(job.data?.action || "").toUpperCase();
    if (action === "CALL") {
        const { aseScheduler } = await import("../../ase/scheduler.service.js");
        aseScheduler.kick();
        return { deferred: true, reason: "voice_via_scheduler", action };
    }
    const { aseScheduler } = await import("../../ase/scheduler.service.js");
    aseScheduler.kick();
    return { kicked: true, action: action || null, leadId: job.data?.leadId || null };
}

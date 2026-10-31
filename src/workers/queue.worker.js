import dotenv from "dotenv";
dotenv.config({ quiet: true });
import dns from "dns";
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder("ipv4first");
}

import { connectDb } from "../config/db.js";
import { closeRedis, isRedisConfigured } from "../config/redis.js";
import { closeQueues, createQueueWorker, QUEUE_NAMES } from "../services/queue/queue.registry.js";
import { processLeadImportJob } from "../services/queue/processors/leadImport.processor.js";
import { processCompanyResearchJob } from "../services/queue/processors/companyResearch.processor.js";
import { processEmailPersonalizationJob } from "../services/queue/processors/emailPersonalization.processor.js";
import { processFollowUpJob } from "../services/queue/processors/followUp.processor.js";
import { processAseActionJob } from "../services/queue/processors/aseAction.processor.js";
import { processCadenceStepJob } from "../services/queue/processors/cadenceStep.processor.js";

let shuttingDown = false;

export function startQueueWorkers() {
    if (!isRedisConfigured()) {
        console.log("[QueueWorker] REDIS_URL is not set; workers not started");
        return [];
    }
    const started = [
        createQueueWorker(QUEUE_NAMES.LEAD_IMPORT, processLeadImportJob),
        createQueueWorker(QUEUE_NAMES.COMPANY_RESEARCH, processCompanyResearchJob),
        createQueueWorker(QUEUE_NAMES.EMAIL_PERSONALIZATION, processEmailPersonalizationJob),
        createQueueWorker(QUEUE_NAMES.FOLLOW_UP, processFollowUpJob),
        createQueueWorker(QUEUE_NAMES.ASE_ACTIONS, processAseActionJob),
        createQueueWorker(QUEUE_NAMES.ASE_CADENCE, processCadenceStepJob),
    ].filter(Boolean);
    console.log(`[QueueWorker] started ${started.length} workers`);
    return started;
}

export async function stopQueueWorkers() {
    if (shuttingDown) return;
    shuttingDown = true;
    await closeQueues();
    await closeRedis();
}

async function runStandalone() {
    if (!isRedisConfigured()) {
        console.error("[QueueWorker] REDIS_URL is required for the worker process");
        process.exit(1);
    }
    process.on("SIGINT", async () => {
        await stopQueueWorkers();
        process.exit(0);
    });
    process.on("SIGTERM", async () => {
        await stopQueueWorkers();
        process.exit(0);
    });
    await connectDb();
    startQueueWorkers();
}

const isDirect = process.argv[1] && String(process.argv[1]).includes("queue.worker");
if (isDirect) {
    runStandalone().catch((error) => {
        console.error("[QueueWorker] fatal:", error.message);
        process.exit(1);
    });
}

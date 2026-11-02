import dotenv from "dotenv";
dotenv.config({ quiet: true });
import dns from "dns";
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder("ipv4first");
}

import { connectDb } from "../config/db.js";
import { enforceJwtConfigOrExit } from "../config/jwtSecret.js";
import { closeRedis, isRedisConfigured } from "../config/redis.js";
import { closeQueues, createQueueWorker, QUEUE_NAMES } from "../services/queue/queue.registry.js";
import { processCompanyResearchJob } from "../services/queue/processors/companyResearch.processor.js";

let shuttingDown = false;

async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    await closeQueues();
    await closeRedis();
    process.exit(0);
}

async function run() {
    enforceJwtConfigOrExit("IntelligenceWorker");
    if (!isRedisConfigured()) {
        console.error("[IntelligenceWorker] REDIS_URL is required");
        process.exit(1);
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await connectDb();
    const worker = createQueueWorker(QUEUE_NAMES.COMPANY_RESEARCH, processCompanyResearchJob);
    console.log(`[IntelligenceWorker] ${worker ? "consuming" : "failed to start"} ${QUEUE_NAMES.COMPANY_RESEARCH}`);
}

run().catch((error) => {
    console.error("[IntelligenceWorker] fatal:", error.message);
    process.exit(1);
});

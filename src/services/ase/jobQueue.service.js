import { env } from "../../config/env.js";

let BullQueue = null;
let BullWorker = null;

try {
    const bullmq = await import("bullmq");
    BullQueue = bullmq.Queue;
    BullWorker = bullmq.Worker;
} catch (_) {}

class JobQueueService {
    constructor() {
        this.queueName = "ase-actions";
        this.redisUrl = process.env.REDIS_URL || null;
        this.queue = null;
        this.worker = null;
        this.localQueue = [];
        this.metrics = {
            totalEnqueued: 0,
            totalProcessed: 0,
            totalFailed: 0,
            activeWorkers: 0,
            mode: "database_fallback",
        };

        this.init();
    }

    init() {
        if (BullQueue && this.redisUrl) {
            try {
                this.queue = new BullQueue(this.queueName, {
                    connection: { url: this.redisUrl },
                });
                this.metrics.mode = "bullmq_redis";
            } catch (_) {
                this.queue = null;
                this.metrics.mode = "database_fallback";
            }
        }
    }

    async enqueueAction({ leadId, orgId = 1, action, delayMs = 0, payload = {}, idempotencyKey = null, maxAttempts = 3 }) {
        this.metrics.totalEnqueued += 1;
        const jobId = idempotencyKey || `job_${orgId}_${leadId}_${action}_${Date.now()}`;
        const jobData = {
            jobId,
            leadId,
            orgId,
            action,
            payload,
            attempts: 0,
            maxAttempts,
            enqueuedAt: new Date().toISOString(),
        };

        if (this.queue && this.metrics.mode === "bullmq_redis") {
            try {
                await this.queue.add("execute_action", jobData, {
                    jobId,
                    delay: delayMs,
                    attempts: maxAttempts,
                    backoff: {
                        type: "exponential",
                        delay: 10000,
                    },
                    removeOnComplete: true,
                });
                return { enqueued: true, mode: "bullmq_redis", jobId };
            } catch (err) {
                this.metrics.mode = "database_fallback";
            }
        }

        const runAt = Date.now() + delayMs;
        this.localQueue.push({ ...jobData, runAt });
        return { enqueued: true, mode: "database_fallback", jobId };
    }

    registerWorker(handler) {
        if (BullWorker && this.redisUrl && this.metrics.mode === "bullmq_redis") {
            try {
                this.worker = new BullWorker(
                    this.queueName,
                    async (job) => {
                        this.metrics.totalProcessed += 1;
                        return handler(job.data);
                    },
                    { connection: { url: this.redisUrl }, concurrency: 5 }
                );
                this.metrics.activeWorkers = 1;
                return;
            } catch (_) {}
        }

        this.metrics.activeWorkers = 1;
        setInterval(async () => {
            const now = Date.now();
            const dueIndices = [];
            for (let i = 0; i < this.localQueue.length; i++) {
                if (this.localQueue[i].runAt <= now) {
                    dueIndices.push(i);
                }
            }

            for (const idx of dueIndices.reverse()) {
                const job = this.localQueue.splice(idx, 1)[0];
                try {
                    this.metrics.totalProcessed += 1;
                    await handler(job);
                } catch (err) {
                    this.metrics.totalFailed += 1;
                    if (job.attempts < job.maxAttempts) {
                        job.attempts += 1;
                        job.runAt = Date.now() + 15000;
                        this.localQueue.push(job);
                    }
                }
            }
        }, 5000);
    }

    getMetrics() {
        return {
            ...this.metrics,
            pendingLocalJobs: this.localQueue.length,
            timestamp: new Date().toISOString(),
        };
    }

    async close() {
        if (this.worker) await this.worker.close();
        if (this.queue) await this.queue.close();
    }
}

export const jobQueue = new JobQueueService();

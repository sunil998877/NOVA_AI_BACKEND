import { enqueueAseActionJob } from "../queue/enqueue.js";
import { shouldEnqueueToRedis } from "../../config/redis.js";

class JobQueueService {
    constructor() {
        this.queueName = "ase-actions";
        this.localQueue = [];
        this.voiceInFlight = 0;
        this.metrics = {
            totalEnqueued: 0,
            totalProcessed: 0,
            totalFailed: 0,
            activeWorkers: 0,
            mode: shouldEnqueueToRedis() ? "bullmq_redis" : "database_fallback",
        };
        this.fallbackTimer = null;
        this.handler = null;
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

        if (shouldEnqueueToRedis()) {
            const queued = await enqueueAseActionJob(jobData, { jobId, delayMs, maxAttempts });
            if (queued) {
                this.metrics.mode = "bullmq_redis";
                return { enqueued: true, mode: "bullmq_redis", jobId: queued.id || jobId };
            }
            this.metrics.mode = "database_fallback";
        }

        const runAt = Date.now() + delayMs;
        this.localQueue.push({ ...jobData, runAt });
        this.metrics.mode = "database_fallback";
        return { enqueued: true, mode: "database_fallback", jobId };
    }

    registerWorker(handler) {
        this.handler = handler;
        this.metrics.activeWorkers = 1;
        if (this.fallbackTimer) return;
        this.fallbackTimer = setInterval(async () => {
            if (!this.handler) return;
            const now = Date.now();
            const due = [];
            this.localQueue = this.localQueue.filter((job) => {
                if (job.runAt <= now) {
                    due.push(job);
                    return false;
                }
                return true;
            });
            for (const job of due) {
                try {
                    this.metrics.totalProcessed += 1;
                    await this.handler(job);
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

    getVoiceInFlight() {
        return this.voiceInFlight;
    }

    beginVoiceJob() {
        this.voiceInFlight += 1;
        return this.voiceInFlight;
    }

    endVoiceJob() {
        this.voiceInFlight = Math.max(0, this.voiceInFlight - 1);
        return this.voiceInFlight;
    }

    getMetrics() {
        return {
            ...this.metrics,
            pendingLocalJobs: this.localQueue.length,
            voiceInFlight: this.voiceInFlight,
            timestamp: new Date().toISOString(),
        };
    }

    async close() {
        if (this.fallbackTimer) {
            clearInterval(this.fallbackTimer);
            this.fallbackTimer = null;
        }
    }
}

export const jobQueue = new JobQueueService();

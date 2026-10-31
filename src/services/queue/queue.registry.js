import { Queue, Worker } from "bullmq";
import { createRedisConnection, isRedisConfigured } from "../../config/redis.js";
import { DEFAULT_JOB_OPTIONS, QUEUE_CONCURRENCY, QUEUE_NAMES } from "./queue.constants.js";

const queues = new Map();
const workers = [];
let producerConnection = null;
let workerConnection = null;

function producerConn() {
    if (!producerConnection) producerConnection = createRedisConnection("bullmq-producer");
    return producerConnection;
}

function workerConn() {
    if (!workerConnection) workerConnection = createRedisConnection("bullmq-worker");
    return workerConnection;
}

export function getQueue(name) {
    if (!isRedisConfigured()) return null;
    if (queues.has(name)) return queues.get(name);
    const connection = producerConn();
    if (!connection) return null;
    const queue = new Queue(name, {
        connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, queue);
    return queue;
}

export function toQueueJobId(rawId) {
    if (rawId === undefined || rawId === null || rawId === "") return undefined;
    const id = String(rawId).replace(/:/g, "-");
    return /^\d+$/.test(id) ? `job-${id}` : id;
}

export async function addQueueJob(name, jobName, data, options = {}) {
    const queue = getQueue(name);
    if (!queue) return null;
    const jobId = toQueueJobId(options.jobId);
    try {
        const job = await queue.add(jobName, data, {
            jobId,
            delay: options.delay || 0,
            attempts: options.attempts || DEFAULT_JOB_OPTIONS.attempts,
            backoff: options.backoff || DEFAULT_JOB_OPTIONS.backoff,
            removeOnComplete: DEFAULT_JOB_OPTIONS.removeOnComplete,
            removeOnFail: DEFAULT_JOB_OPTIONS.removeOnFail,
        });
        return { id: job.id, queue: name, name: jobName };
    } catch (error) {
        if (String(error.message || "").includes("Job is already")) {
            return { id: jobId, queue: name, name: jobName, duplicate: true };
        }
        console.error("[Queue] enqueue failed:", error.message);
        return null;
    }
}

export function createQueueWorker(name, processor) {
    const connection = workerConn();
    if (!connection) return null;
    const worker = new Worker(name, processor, {
        connection,
        concurrency: QUEUE_CONCURRENCY[name] || 2,
        lockDuration: 120000,
    });
    worker.on("failed", (job, error) => {
        console.error(`[Queue] ${name} job ${job?.id} failed:`, error?.message || error);
    });
    worker.on("error", (error) => {
        console.error(`[Queue] ${name} worker error:`, error.message);
    });
    workers.push(worker);
    return worker;
}

export async function getQueueSnapshot() {
    const names = Object.values(QUEUE_NAMES);
    const snapshot = [];
    for (const name of names) {
        const queue = getQueue(name);
        if (!queue) {
            snapshot.push({ name, mode: "disabled", counts: null });
            continue;
        }
        try {
            const counts = await queue.getJobCounts("wait", "active", "completed", "failed", "delayed", "paused");
            const failed = await queue.getFailed(0, 9);
            snapshot.push({
                name,
                mode: "bullmq",
                counts,
                failed: failed.map((job) => ({
                    id: job.id,
                    name: job.name,
                    attemptsMade: job.attemptsMade,
                    failedReason: String(job.failedReason || "").slice(0, 240),
                    finishedOn: job.finishedOn || null,
                })),
            });
        } catch (error) {
            snapshot.push({ name, mode: "error", error: error.message, counts: null });
        }
    }
    return snapshot;
}

export async function closeQueues() {
    await Promise.all(workers.splice(0).map((worker) => worker.close().catch(() => {})));
    await Promise.all([...queues.values()].map((queue) => queue.close().catch(() => {})));
    queues.clear();
}

export { QUEUE_NAMES };

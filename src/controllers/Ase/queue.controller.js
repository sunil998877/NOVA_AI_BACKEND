import { asyncHandler } from "../../utils/asyncHandler.js";
import { redisHealth, shouldRunQueueWorkers, shouldEnqueueToRedis } from "../../config/redis.js";
import { getQueueSnapshot } from "../../services/queue/queue.registry.js";
import { getCacheMetrics } from "../../services/queue/cache.service.js";
import { jobQueue } from "../../services/ase/jobQueue.service.js";
import { LeadImportJob } from "../../models/lead-import-job.model.js";

export const getQueueStatus = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const [health, queues, imports] = await Promise.all([
        redisHealth(),
        getQueueSnapshot(),
        LeadImportJob.listRecent(orgId, 10).catch(() => []),
    ]);
    return res.status(200).json({
        data: {
            redis: health,
            enqueueEnabled: shouldEnqueueToRedis(),
            workersEnabled: shouldRunQueueWorkers(),
            cache: getCacheMetrics(),
            jobQueue: jobQueue.getMetrics(),
            queues,
            imports,
        },
    });
});

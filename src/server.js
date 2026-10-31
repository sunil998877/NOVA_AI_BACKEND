import dotenv from "dotenv";
dotenv.config({ quiet: true });

import dns from "dns";
if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder("ipv4first");
}
import http from "http";
import { env } from "./config/env.js";
import { connectDb } from "./config/db.js";
import { app } from "./app.js";
import { initSocketServer } from "./socket/socketServer.js";
import { aseScheduler } from "./services/ase/scheduler.service.js";
import { ensureMlService, stopMlService } from "./services/ase/brain/mlServiceProcess.js";
import { emailReplyListener } from "./services/ase/emailReplyListener.service.js";
import { followUpScheduler } from "./services/followup/followUpScheduler.service.js";
import { shouldRunQueueWorkers } from "./config/redis.js";
import { startQueueWorkers, stopQueueWorkers } from "./workers/queue.worker.js";
import { closeQueues } from "./services/queue/queue.registry.js";
import { jobQueue } from "./services/ase/jobQueue.service.js";


const startServer = () => {
    const httpServer = http.createServer(app);

    initSocketServer(httpServer);

    const port = Number(process.env.PORT || env.port || 10000);
    const host = "0.0.0.0";

    httpServer.listen(port, host, () => {
        console.log(`NovaAI backend & Socket.IO running on ${host}:${port}`);
        console.log(
            `n8n webhook: ${env.n8nWebhookUrl || env.n8nMainWebhook || "(not configured)"}`
        );
        if (env.bypassTimingGates) {
            console.log("[ASE] Timing gates bypassed (calling hours, cadence, cooldown, scanner delay) for local lag testing");
        }
    });

    httpServer.on("error", (error) => {
        console.error("Error starting the server:", error);
        process.exit(1);
    });

    const mlReady = ensureMlService();
    const shutdown = async () => {
        stopMlService();
        emailReplyListener.stop();
        followUpScheduler.stop();
        await jobQueue.close().catch(() => {});
        await stopQueueWorkers().catch(() => {});
        await closeQueues().catch(() => {});
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    
    process.on("unhandledRejection", (reason) => {
        console.error("Unhandled Rejection:", reason?.message || reason);
    });
    process.on("uncaughtException", (error) => {
        console.error("Uncaught Exception:", error?.message || error);
    });

    connectDb()
        .then(async () => {
            await mlReady;
            aseScheduler.start();
            emailReplyListener.start();
            followUpScheduler.start();
            if (shouldRunQueueWorkers()) {
                startQueueWorkers();
            }
        })
        .catch((err) => {
            console.error("Initial database connection error:", err.message);
        });
};

startServer();
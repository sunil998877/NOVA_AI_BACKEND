import "dotenv/config";
import http from "http";
import { env } from "./config/env.js";
import { connectDb } from "./config/db.js";
import { app } from "./app.js";
import { initSocketServer } from "./socket/socketServer.js";
import { aseScheduler } from "./services/ase/scheduler.service.js";
import { ensureMlService, stopMlService } from "./services/ase/brain/mlServiceProcess.js";
import { emailReplyListener } from "./services/ase/emailReplyListener.service.js";


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
    });

    httpServer.on("error", (error) => {
        console.error("Error starting the server:", error);
        process.exit(1);
    });

    ensureMlService();
    process.on("SIGINT", () => {
        stopMlService();
        emailReplyListener.stop();
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        stopMlService();
        emailReplyListener.stop();
        process.exit(0);
    });

    connectDb()
        .then(() => {
            aseScheduler.start();
            emailReplyListener.start();
        })
        .catch((err) => {
            console.error("Initial database connection error:", err.message);
        });
};

startServer();
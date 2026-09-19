import http from "http";
import { env } from "./config/env.js";
import { connectDb } from "./config/db.js";
import { app } from "./app.js";
import { initSocketServer } from "./socket/socketServer.js";

const startServer = () => {
    // 1. Create HTTP Server wrapping Express app
    const httpServer = http.createServer(app);

    // 2. Initialize Socket.IO on the same HTTP server
    initSocketServer(httpServer);

    const port = Number(process.env.PORT || env.port || 10000);
    const host = "0.0.0.0";

    // 3. Listen immediately on 0.0.0.0 so Render detects the open port instantly
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

    // 4. Initialize Database asynchronously so port binding is never blocked
    connectDb().catch((err) => {
        console.error("Initial database connection error:", err.message);
    });
};

startServer();
import http from "http";
import { env } from "./config/env.js";
import { connectDb } from "./config/db.js";
import { app } from "./app.js";
import { initSocketServer } from "./socket/socketServer.js";

const syncServer = async () => {
    await connectDb();

    // Create HTTP Server wrapping Express app
    const httpServer = http.createServer(app);

    // Initialize Socket.IO on the same HTTP server
    const io = initSocketServer(httpServer);

    httpServer.listen(env.port, () => {
        console.log(`NovaAI backend & Socket.IO running on port ${env.port}`);
        console.log(
            `n8n webhook: ${env.n8nWebhookUrl || env.n8nMainWebhook || "(not configured)"}`
        );
    });

    httpServer.on("error", (error) => {
        console.error("Error starting the server:", error);
        process.exit(1);
    });
};

syncServer();
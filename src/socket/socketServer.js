import { Server } from "socket.io";
import { env } from "../config/env.js";
import { socketAuth } from "./socketAuth.js";
import { registerChatHandlers } from "./chatHandlers.js";

let ioInstance = null;

/**
 * Initialize Socket.IO attached to existing Express HTTP Server.
 * Supports CORS, WebSocket/polling transports, and heartbeat timeouts.
 */
export function initSocketServer(httpServer) {
    if (ioInstance) return ioInstance;

    const allowedOrigins = [
        ...new Set([
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            env.frontendUrl,
            ...(env.allowedOrigins || []),
        ]),
    ].filter(Boolean);

    const io = new Server(httpServer, {
        cors: {
            origin: (origin, callback) => {
                if (!origin) return callback(null, true);
                const normalized = origin.replace(/\/$/, "");
                const matched = allowedOrigins.some(
                    (allowed) =>
                        allowed === normalized ||
                        allowed === origin ||
                        normalized.includes("localhost") ||
                        normalized.includes("127.0.0.1") ||
                        normalized.endsWith(".onrender.com") ||
                        normalized.includes("onrender.com") ||
                        normalized.endsWith(".hostingersite.com")
                );
                if (matched || env.nodeEnv !== "production") {
                    return callback(null, true);
                }
                return callback(null, false);
            },
            credentials: true,
            methods: ["GET", "POST"],
        },
        transports: ["websocket", "polling"],
        pingTimeout: 20000,
        pingInterval: 25000,
        maxHttpBufferSize: 1e6, // 1MB max payload for safety
    });

    // Authentication middleware
    io.use(socketAuth);

    // Connection lifecycle
    io.on("connection", (socket) => {
        registerChatHandlers(io, socket);
    });

    ioInstance = io;
    console.log("[Socket.IO] Real-time chat server initialized successfully");
    return io;
}

/**
 * Access the active Socket.IO server instance anywhere in backend.
 */
export function getIo() {
    return ioInstance;
}

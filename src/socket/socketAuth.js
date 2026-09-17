import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User } from "../models/user.model.js";
import { Collaboration } from "../models/collaboration.model.js";

/**
 * Socket.IO authentication middleware.
 * Authenticates NOVA users via JWT or Influencers via collaboration access token.
 */
export async function socketAuth(socket, next) {
    try {
        const auth = socket.handshake.auth || {};
        const query = socket.handshake.query || {};
        const headers = socket.handshake.headers || {};

        let token = auth.token || auth.accessToken || query.token || query.accessToken || "";
        if (!token && headers.authorization) {
            const authHeader = headers.authorization;
            if (authHeader.startsWith("Bearer ")) {
                token = authHeader.slice("Bearer ".length).trim();
            } else {
                token = authHeader.trim();
            }
        }

        if (!token) {
            return next(new Error("Unauthorized: No authentication token provided"));
        }

        // 1. Check if token is a valid JWT (NOVA User)
        if (env.jwtSecret) {
            try {
                const payload = jwt.verify(token, env.jwtSecret);
                if (payload?.sub) {
                    const user = await User.findById(payload.sub);
                    if (user) {
                        socket.user = {
                            id: String(user.id),
                            userId: Number(user.id),
                            role: "user",
                            senderType: "user",
                            name: user.fullName || user.email || "Marketer",
                            email: user.email,
                        };
                        return next();
                    }
                }
            } catch (_) {
                // Not a valid JWT, fall through to check if it's an Influencer portal access token
            }
        }

        // 2. Check if token is an Influencer Collaboration access token (UUID / string)
        try {
            const collab = await Collaboration.findByToken(token);
            if (collab) {
                const influencerId = collab.influencer_id ? String(collab.influencer_id) : `inf-${collab.id}`;
                socket.user = {
                    id: influencerId,
                    role: "influencer",
                    senderType: "influencer",
                    collabId: collab.id,
                    name: collab.influencer_name || "Creator",
                    email: collab.recipient_email,
                    influencerId: collab.influencer_id,
                    token,
                };
                return next();
            }
        } catch (_) {}

        return next(new Error("Unauthorized: Invalid credentials"));
    } catch (err) {
        return next(new Error("Authentication failed: " + err.message));
    }
}

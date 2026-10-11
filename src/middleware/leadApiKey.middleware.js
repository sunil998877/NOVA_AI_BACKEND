import crypto from "crypto";
import { env } from "../config/env.js";
import { authenticate } from "./auth.middleware.js";

const safeEqual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Auth for the public lead API (POST /api/leads).
 * - External systems: send `x-api-key: <LEADS_API_KEY>`; leads are owned by LEADS_API_USER_ID.
 * - Logged-in app users: normal `Authorization: Bearer <jwt>`.
 */
export const authenticateLeadApi = (req, res, next) => {
    const apiKey = req.headers["x-api-key"];
    if (apiKey) {
        if (!env.leadsApiKey || !env.leadsApiUserId) {
            return res.status(503).json({ error: "Lead API key is not configured on the server" });
        }
        if (!safeEqual(apiKey, env.leadsApiKey)) {
            return res.status(401).json({ error: "Invalid API key" });
        }
        req.user = {
            id: String(env.leadsApiUserId),
            organization_id: Number(req.headers["x-organization-id"] || 1),
            role: "api_service",
        };
        req.authVia = "lead_api_key";
        return next();
    }
    return authenticate(req, res, next);
};

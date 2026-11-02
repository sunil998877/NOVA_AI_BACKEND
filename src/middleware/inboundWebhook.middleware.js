import crypto from "crypto";
import { env } from "../config/env.js";

let warnedUnconfigured = false;

function safeEqual(a, b) {
    const left = crypto.createHash("sha256").update(String(a)).digest();
    const right = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(left, right);
}

/**
 * Inbound email providers must send INBOUND_EMAIL_WEBHOOK_SECRET as `x-inbound-webhook-secret`
 * (or `Authorization: Bearer <secret>`). Production refuses all calls when the secret is unset.
 */
export function requireInboundWebhookSecret(secret = env.inboundEmailWebhookSecret, nodeEnv = env.nodeEnv) {
    return (req, res, next) => {
        if (!secret) {
            if (nodeEnv === "production") {
                return res.status(503).json({ error: "Inbound email webhook is not configured" });
            }
            if (!warnedUnconfigured) {
                warnedUnconfigured = true;
                console.warn("[Security] INBOUND_EMAIL_WEBHOOK_SECRET is not set; inbound webhook is open (development only)");
            }
            return next();
        }
        const header = req.get("x-inbound-webhook-secret")
            || String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
        if (!header || !safeEqual(header, secret)) {
            return res.status(401).json({ error: "Invalid inbound webhook signature" });
        }
        return next();
    };
}

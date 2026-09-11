import { env } from "../config/env.js";

let cachedTunnelUrl = null;
let lastTunnelCheck = 0;
const TUNNEL_CACHE_TTL_MS = 5000;

/**
 * Resolves the public base URL for email tracking and callbacks.
 * Priority:
 * 1. Live local ngrok tunnel via http://127.0.0.1:4040/api/tunnels
 * 2. process.env.PUBLIC_API_URL (if configured and valid)
 * 3. process.env.VITE_BACKEND_URL or req host
 */
export async function getPublicApiUrl(req = null) {
    const now = Date.now();
    if (cachedTunnelUrl && (now - lastTunnelCheck) < TUNNEL_CACHE_TTL_MS) {
        return cachedTunnelUrl;
    }

    // 1. Try discovering an active local ngrok tunnel
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 800);
        const res = await fetch("http://127.0.0.1:4040/api/tunnels", {
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });
        clearTimeout(timeoutId);

        if (res.ok) {
            const data = await res.json();
            const httpsTunnel = data.tunnels?.find(
                (t) => t.proto === "https" || (t.public_url && t.public_url.startsWith("https://"))
            );
            const tunnelUrl = httpsTunnel?.public_url || data.tunnels?.[0]?.public_url;
            if (tunnelUrl) {
                const cleaned = tunnelUrl.replace(/\/$/, "");
                cachedTunnelUrl = cleaned;
                lastTunnelCheck = now;
                return cleaned;
            }
        }
    } catch {
        // ngrok web interface not responding or not running locally
    }

    // 2. Fall back to process.env.PUBLIC_API_URL if configured
    const configuredPublicUrl = process.env.PUBLIC_API_URL?.trim();
    if (configuredPublicUrl && !configuredPublicUrl.includes("placeholder")) {
        return configuredPublicUrl.replace(/\/$/, "");
    }

    // 3. Fall back to VITE_BACKEND_URL or request origin
    const configuredBackendUrl = process.env.VITE_BACKEND_URL?.trim();
    if (configuredBackendUrl && !configuredBackendUrl.includes("localhost") && !configuredBackendUrl.includes("127.0.0.1")) {
        return configuredBackendUrl.replace(/\/$/, "");
    }

    if (req) {
        const proto = req.get("x-forwarded-proto") || req.protocol || "http";
        const host = req.get("x-forwarded-host") || req.get("host");
        if (host) {
            return `${proto}://${host}`.replace(/\/$/, "");
        }
    }

    return (configuredBackendUrl || "http://localhost:3001").replace(/\/$/, "");
}

import { env } from "../config/env.js";

export async function resolvePublicBaseUrl() {
    try {
        const ngrokRes = await fetch("http://127.0.0.1:4040/api/tunnels", {
            signal: AbortSignal.timeout(600),
        });
        if (ngrokRes.ok) {
            const tunnelData = await ngrokRes.json();
            const tunnels = Array.isArray(tunnelData?.tunnels) ? tunnelData.tunnels : [];
            const httpsTunnel = tunnels.find((tunnel) => String(tunnel.public_url || "").startsWith("https://"));
            const activeTunnel = httpsTunnel?.public_url || tunnels[0]?.public_url;
            if (activeTunnel) return String(activeTunnel).replace(/\/$/, "");
        }
    } catch (_) {}

    const configured = String(env.publicApiUrl || "").replace(/\/$/, "");
    if (configured) return configured;
    return `http://localhost:${env.port || 3001}`;
}

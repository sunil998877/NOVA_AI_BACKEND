import Redis from "ioredis";
import { env } from "./env.js";

const clients = new Set();
let cacheClient = null;
let lastError = null;
let warnedInternalHost = false;

export function redactRedisUrl(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    try {
        const parsed = new URL(value);
        if (parsed.password) parsed.password = "***";
        if (parsed.username && parsed.username !== "default") parsed.username = "***";
        return parsed.port
            ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}`
            : `${parsed.protocol}//${parsed.host}`;
    } catch {
        return "redis";
    }
}

function redisConfig() {
    return env.redis || { url: env.redisUrl || "", host: "", port: 6379, username: "", password: "", tls: false };
}

function warnIfUnreachableHost(host) {
    if (warnedInternalHost) return;
    if (!/\.railway\.internal$/i.test(String(host || ""))) return;
    if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return;
    warnedInternalHost = true;
    console.error(
        `[Redis] ${host} is a Railway private hostname, not a public Redis URL.\n` +
        "  It only works inside Railway. This machine will use redis://127.0.0.1:6379 instead.\n" +
        "  To use Railway from local, set REDIS_PUBLIC_URL to the TCP Proxy URL (*.proxy.rlwy.net)."
    );
}

export function redisConnectionOptions(kind = "shared") {
    const redis = redisConfig();
    if (!redis.url && !redis.host) return null;
    warnIfUnreachableHost(redis.host);
    const tls = redis.tls ? {} : undefined;
    return {
        host: redis.host,
        port: Number(redis.port || 6379),
        username: redis.username || undefined,
        password: redis.password || undefined,
        url: redis.url,
        kind,
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        connectTimeout: 8000,
        family: 0,
        tls,
    };
}

function attachClient(client, kind) {
    clients.add(client);
    client.on("error", (error) => {
        lastError = error?.message || "redis_error";
        if (/ENOTFOUND/i.test(lastError)) {
            warnIfUnreachableHost(redisConfig().host);
        }
        console.error(`[Redis] ${kind} error:`, lastError);
    });
    client.on("ready", () => {
        lastError = null;
        console.log(`[Redis] ${kind} ready (${redactRedisUrl(redisConfig().url) || redisConfig().host})`);
    });
    return client;
}

export function createRedisConnection(kind = "shared") {
    const options = redisConnectionOptions(kind);
    if (!options) return null;
    const client = new Redis({
        host: options.host,
        port: options.port,
        username: options.username,
        password: options.password,
        maxRetriesPerRequest: options.maxRetriesPerRequest,
        enableReadyCheck: options.enableReadyCheck,
        connectTimeout: options.connectTimeout,
        family: options.family,
        tls: options.tls,
        lazyConnect: true,
        enableOfflineQueue: false,
        connectionName: `nova-${kind}`,
        retryStrategy(times) {
            if (/ENOTFOUND|EAI_FAIL/i.test(lastError || "")) {
                return times >= 2 ? null : 500;
            }
            return Math.min(times * 200, 2000);
        },
    });
    return attachClient(client, kind);
}

export function getRedis() {
    if (typeof process.env.NODE_TEST_CONTEXT !== "undefined") return null;
    if (!isRedisConfigured()) return null;
    if (!cacheClient) {
        cacheClient = createRedisConnection("cache");
    }
    return cacheClient;
}

export function isRedisConfigured() {
    const redis = redisConfig();
    return Boolean(redis.url || redis.host);
}

export function shouldRunQueueWorkers() {
    if (typeof process.env.NODE_TEST_CONTEXT !== "undefined") return false;
    if (!isRedisConfigured()) return false;
    return env.queueRole === "worker" || env.queueRole === "all";
}

export function shouldEnqueueToRedis() {
    if (typeof process.env.NODE_TEST_CONTEXT !== "undefined") return false;
    return isRedisConfigured();
}

export async function redisHealth() {
    if (!isRedisConfigured()) {
        return { ok: false, mode: "disabled" };
    }
    const client = getRedis();
    if (!client) {
        return { ok: false, mode: "uninitialized", error: lastError };
    }
    try {
        const pong = await client.ping();
        return { ok: pong === "PONG", mode: "ioredis", host: redisConfig().host };
    } catch (error) {
        return { ok: false, mode: "error", error: error.message };
    }
}

export async function closeRedis() {
    const open = [...clients];
    clients.clear();
    cacheClient = null;
    await Promise.all(open.map(async (client) => {
        try {
            await client.quit();
        } catch {
            client.disconnect();
        }
    }));
}

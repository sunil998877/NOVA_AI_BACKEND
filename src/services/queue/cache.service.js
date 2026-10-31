import { env } from "../../config/env.js";
import { getRedis } from "../../config/redis.js";
import { CACHE_KEYS, RESEARCH_CACHE_SCHEMA } from "./queue.constants.js";

const metrics = {
    hits: 0,
    misses: 0,
    writes: 0,
    errors: 0,
};

function ttlSeconds() {
    const hours = Number(env.researchCacheTtlHours || 6);
    return Math.max(60, Math.round(hours * 3600));
}

export function getCacheMetrics() {
    const total = metrics.hits + metrics.misses;
    return {
        ...metrics,
        hitRate: total ? Number((metrics.hits / total).toFixed(4)) : 0,
    };
}

export async function cacheGet(key) {
    const redis = getRedis();
    if (!redis) {
        metrics.misses += 1;
        return null;
    }
    try {
        const raw = await redis.get(key);
        if (!raw) {
            metrics.misses += 1;
            return null;
        }
        metrics.hits += 1;
        return JSON.parse(raw);
    } catch (error) {
        metrics.errors += 1;
        metrics.misses += 1;
        console.error("[RedisCache] get failed:", error.message);
        return null;
    }
}

export async function cacheSet(key, value, ttl = ttlSeconds()) {
    const redis = getRedis();
    if (!redis) return false;
    try {
        await redis.set(key, JSON.stringify(value), "EX", ttl);
        metrics.writes += 1;
        return true;
    } catch (error) {
        metrics.errors += 1;
        console.error("[RedisCache] set failed:", error.message);
        return false;
    }
}

export async function cacheDel(key) {
    const redis = getRedis();
    if (!redis) return false;
    try {
        await redis.del(key);
        return true;
    } catch (error) {
        metrics.errors += 1;
        console.error("[RedisCache] del failed:", error.message);
        return false;
    }
}

export async function acquireLock(name, ttlMs = 30000) {
    const redis = getRedis();
    if (!redis) return "memory";
    try {
        const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const result = await redis.set(CACHE_KEYS.LOCK(name), token, "PX", ttlMs, "NX");
        return result === "OK" ? token : null;
    } catch (error) {
        metrics.errors += 1;
        return "memory";
    }
}

export async function releaseLock(name, token) {
    const redis = getRedis();
    if (!redis || !token || token === "memory") return;
    const key = CACHE_KEYS.LOCK(name);
    try {
        const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
        await redis.eval(script, 1, key, token);
    } catch (_) {}
}

// Fails open (runs) when Redis is unavailable; callers must still rely on atomic DB claims.
export async function withCycleLock(name, ttlMs, fn) {
    const token = await acquireLock(name, ttlMs);
    if (!token) return { lockHeld: true };
    try {
        return await fn();
    } finally {
        await releaseLock(name, token);
    }
}

export async function getCachedResearch(domain) {
    if (!domain) return null;
    const payload = await cacheGet(CACHE_KEYS.RESEARCH(domain));
    if (!payload || payload.schemaVersion !== RESEARCH_CACHE_SCHEMA) return null;
    return payload.research || null;
}

export async function setCachedResearch(domain, research) {
    if (!domain || !research) return false;
    return cacheSet(CACHE_KEYS.RESEARCH(domain), {
        schemaVersion: RESEARCH_CACHE_SCHEMA,
        research,
        cachedAt: new Date().toISOString(),
    });
}

export async function invalidateResearch(domain) {
    if (!domain) return false;
    return cacheDel(CACHE_KEYS.RESEARCH(domain));
}

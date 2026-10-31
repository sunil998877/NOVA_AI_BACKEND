import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRedisConfig } from "../config/env.js";
import { redactRedisUrl, isRedisConfigured, shouldEnqueueToRedis } from "../config/redis.js";
import { CACHE_KEYS, JOB_NAMES, QUEUE_NAMES, RESEARCH_CACHE_SCHEMA } from "../services/queue/queue.constants.js";
import { cacheGet, getCacheMetrics } from "../services/queue/cache.service.js";
import { jobQueue } from "../services/ase/jobQueue.service.js";
import { processAseActionJob } from "../services/queue/processors/aseAction.processor.js";

test("redacts redis credentials from URLs", () => {
    const hidden = redactRedisUrl("rediss://nova:super-secret@redis.example.com:6379/0");
    assert.equal(hidden.includes("super-secret"), false);
    assert.equal(hidden.includes("redis.example.com"), true);
    assert.equal(redactRedisUrl(""), "");
});

test("builds Redis config from split Railway credentials", () => {
    const redis = resolveRedisConfig({
        REDIS_HOST: "redis.example.com",
        REDIS_PORT: "6379",
        REDIS_USER: "default",
        REDIS_PASSWORD: "secret-pass",
    });
    assert.equal(redis.host, "redis.example.com");
    assert.equal(redis.port, 6379);
    assert.equal(redis.username, "default");
    assert.equal(redis.password, "secret-pass");
    assert.match(redis.url, /redis:\/\/default:secret-pass@redis.example.com:6379/);
});

test("local machines prefer REDIS_PUBLIC_URL over railway.internal", () => {
    const redis = resolveRedisConfig({
        REDIS_URL: "redis://default:secret@redis.railway.internal:6379",
        REDIS_HOST: "redis.railway.internal",
        REDIS_PORT: "6379",
        REDIS_USER: "default",
        REDIS_PASSWORD: "secret",
        REDIS_PUBLIC_URL: "redis://default:secret@hopper.proxy.rlwy.net:12345",
    });
    assert.equal(redis.host, "hopper.proxy.rlwy.net");
    assert.equal(redis.port, 12345);
});

test("does not treat railway.internal REDIS_URL as a public host", () => {
    const redis = resolveRedisConfig({
        REDIS_URL: "redis://default:secret@redis.railway.internal:6379",
        REDIS_HOST: "redis.railway.internal",
        REDIS_PORT: "6379",
        REDIS_USER: "default",
        REDIS_PASSWORD: "secret",
        REDIS_PUBLIC_URL: "redis://default:secret@redis.railway.internal:6379",
    });
    assert.equal(redis.host, "127.0.0.1");
    assert.equal(redis.port, 6379);
    assert.equal(redis.fallbackFromInternal, true);
});

test("queue names and job ids stay stable", () => {
    assert.equal(QUEUE_NAMES.ASE_ACTIONS, "ase-actions");
    assert.equal(QUEUE_NAMES.COMPANY_RESEARCH, "nova-company-research");
    assert.equal(JOB_NAMES.RESEARCH_COMPANY, "research_company");
    assert.equal(CACHE_KEYS.RESEARCH("acme.com"), "company:research:acme.com");
    assert.equal(CACHE_KEYS.PROFILE(1, "acme"), "company:profile:1:acme");
    assert.equal(RESEARCH_CACHE_SCHEMA, 1);
});

test("cache miss is safe when Redis is down", async () => {
    const missed = await cacheGet("company:research:missing.example");
    assert.equal(missed, null);
    const metrics = getCacheMetrics();
    assert.ok(metrics.misses >= 1);
});

test("jobQueue falls back without blocking when Redis is unavailable", async () => {
    const result = await jobQueue.enqueueAction({
        leadId: 42,
        orgId: 1,
        action: "EMAIL",
        delayMs: 500,
        idempotencyKey: "test-email-42",
    });
    assert.equal(result.enqueued, true);
    assert.ok(result.jobId);
    if (!isRedisConfigured()) {
        assert.equal(result.mode, "database_fallback");
        assert.equal(shouldEnqueueToRedis(), false);
    }
});

test("duplicate follow-up job ids are deterministic", () => {
    const orgId = 9;
    const taskId = 17;
    const first = `followup:${orgId}:${taskId}`;
    const second = `followup:${orgId}:${taskId}`;
    assert.equal(first, second);
});

test("ASE action jobs do not dispatch voice themselves", async () => {
    const original = await import("../services/ase/scheduler.service.js");
    const kicked = [];
    const previous = original.aseScheduler.kick;
    original.aseScheduler.kick = () => kicked.push("kick");
    try {
        const callResult = await processAseActionJob({ data: { action: "CALL", leadId: 99 } });
        assert.equal(callResult.deferred, true);
        assert.equal(callResult.reason, "voice_via_scheduler");
        const emailResult = await processAseActionJob({ data: { action: "EMAIL", leadId: 99 } });
        assert.equal(emailResult.kicked, true);
        assert.ok(kicked.length >= 2);
    } finally {
        original.aseScheduler.kick = previous;
    }
});

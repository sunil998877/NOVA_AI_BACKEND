import crypto from "crypto";
import { env } from "../../config/env.js";
import { query, execute } from "../../config/db.js";

const safeEqual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export const leadApiOrganizationId = () => Number(env.leadsApiOrgId || 1);

export function maskApiKey(key) {
    const text = String(key || "");
    if (text.length < 8) return text ? "••••••••" : "";
    return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

const hashKey = (plaintext) => {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(String(plaintext), salt, 32).toString("hex");
    return `scrypt:${salt}:${hash}`;
};

const verifyHash = (plaintext, stored) => {
    const [algo, salt, hash] = String(stored || "").split(":");
    if (algo !== "scrypt" || !salt || !hash) return false;
    const next = crypto.scryptSync(String(plaintext), salt, 32).toString("hex");
    return safeEqual(next, hash);
};

async function readSettings(orgId) {
    const rows = await query("SELECT settings FROM organizations WHERE id = ? LIMIT 1", [orgId]);
    const raw = rows[0]?.settings;
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

export async function verifyLeadApiKey(apiKey) {
    const organizationId = leadApiOrganizationId();
    if (!apiKey) {
        return { ok: false, status: 401, error: "API key is required" };
    }

    const settings = await readSettings(organizationId);
    const stored = settings.leadApiKey?.hash || "";

    if (stored) {
        if (!verifyHash(apiKey, stored)) {
            return { ok: false, status: 401, error: "Invalid API key" };
        }
    } else if (!env.leadsApiKey) {
        return { ok: false, status: 503, error: "Lead API key is not configured on the server" };
    } else if (!safeEqual(apiKey, env.leadsApiKey)) {
        return { ok: false, status: 401, error: "Invalid API key" };
    }

    return {
        ok: true,
        organizationId,
        userId: env.leadsApiUserId || "1",
        apiKeyPrefix: settings.leadApiKey?.prefix || String(env.leadsApiKey || "").slice(0, 4),
        keyStoredAsHash: Boolean(stored),
    };
}

export async function describeLeadApiKey() {
    const organizationId = leadApiOrganizationId();
    const settings = await readSettings(organizationId);
    const stored = settings.leadApiKey || null;
    const hashed = Boolean(stored?.hash);
    const envKey = env.leadsApiKey || "";
    return {
        organizationId,
        apiKey: hashed ? null : envKey || null,
        apiKeyPrefix: stored?.prefix || (envKey ? envKey.slice(0, 4) : ""),
        apiKeyMasked: hashed ? `${stored.prefix || "ase_"}••••` : maskApiKey(envKey),
        apiKeyConfigured: hashed || Boolean(envKey),
        keyStoredAsHash: hashed,
        rotatedAt: stored?.rotatedAt || null,
    };
}

export async function rotateLeadApiKey() {
    const organizationId = leadApiOrganizationId();
    const plaintext = `ase_${crypto.randomBytes(24).toString("hex")}`;
    const settings = await readSettings(organizationId);
    const prefix = plaintext.slice(0, 8);
    settings.leadApiKey = {
        hash: hashKey(plaintext),
        prefix,
        rotatedAt: new Date().toISOString(),
    };
    const updated = await execute(
        "UPDATE organizations SET settings = ? WHERE id = ?",
        [JSON.stringify(settings), organizationId]
    );
    if (!updated?.affectedRows) {
        throw new Error("Organization record was not found for API key rotation");
    }
    return {
        apiKey: plaintext,
        apiKeyPrefix: prefix,
        apiKeyMasked: maskApiKey(plaintext),
        organizationId,
        rotatedAt: settings.leadApiKey.rotatedAt,
    };
}

export function publicApiBase(req) {
    const host = req.get("host") || "";
    const requestBase = `${req.protocol}://${host}`.replace(/\/$/, "");
    const configured = String(env.publicApiUrl || "").replace(/\/$/, "");
    const localRequest = /localhost|127\.0\.0\.1/i.test(host);
    if (localRequest) return requestBase;
    return configured || requestBase;
}

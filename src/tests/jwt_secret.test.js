import test, { describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { resolveJwtConfig, secretFingerprint, validateJwtSecret } from "../config/jwtSecret.js";
import { signAuthToken, signPurposeToken, verifyAuthToken, verifyPurposeToken } from "../utils/jwt.js";

const serverEntry = fileURLToPath(new URL("../server.js", import.meta.url));
const strongSecret = () => crypto.randomBytes(48).toString("base64url");

function startServerWith(jwtEnv) {
    const childEnv = { ...process.env, PORT: "0", NODE_ENV: "development" };
    delete childEnv.JWT_SECRET;
    delete childEnv.JWT_SECRET_PREVIOUS;
    delete childEnv.NODE_TEST_CONTEXT;
    Object.assign(childEnv, jwtEnv);
    // cwd without a .env so dotenv cannot supply the real secret.
    return spawnSync(process.execPath, [serverEntry], {
        cwd: os.tmpdir(),
        env: childEnv,
        encoding: "utf8",
        timeout: 60000,
    });
}

function withSecrets(current, previous, fn) {
    const saved = { secret: env.jwtSecret, previous: env.jwtPreviousSecrets };
    env.jwtSecret = current;
    env.jwtPreviousSecrets = previous;
    try {
        return fn();
    } finally {
        env.jwtSecret = saved.secret;
        env.jwtPreviousSecrets = saved.previous;
    }
}

describe("JWT_SECRET configuration", () => {
    test("missing JWT_SECRET fails startup with a clear error", () => {
        const run = startServerWith({});
        assert.equal(run.status, 1, run.stdout + run.stderr);
        assert.match(run.stderr, /JWT_SECRET is missing/);
        assert.doesNotMatch(run.stdout, /running on/);
    });

    test("invalid JWT_SECRET fails startup and is never echoed", () => {
        const weak = "short-secret-123";
        const run = startServerWith({ JWT_SECRET: weak });
        assert.equal(run.status, 1, run.stdout + run.stderr);
        assert.match(run.stderr, /at least 32 characters/);
        assert.ok(!(run.stdout + run.stderr).includes(weak), "secret value must not be logged");

        const oldFallback = startServerWith({ JWT_SECRET: "NOVA_AI_JWT_SECRET_9f7K2mP4xL8vQ6sR3tY5nW1aZ0cD8eF7" });
        assert.equal(oldFallback.status, 1);
        assert.match(oldFallback.stderr, /known default or placeholder/);
    });

    test("validation rejects placeholders, low entropy and a reused previous secret", () => {
        assert.equal(validateJwtSecret("").valid, false);
        assert.equal(validateJwtSecret("a".repeat(64)).valid, false);
        assert.equal(validateJwtSecret("please-change-me-to-a-real-secret-value-0123456789").valid, false);
        assert.equal(validateJwtSecret(strongSecret()).valid, true);

        const same = strongSecret();
        const config = resolveJwtConfig({ JWT_SECRET: same, JWT_SECRET_PREVIOUS: same });
        assert.equal(config.valid, false);
        assert.match(config.errors.join(";"), /must differ/);
    });

    test("valid secret signs and verifies; expiry is preserved", () => {
        const secret = strongSecret();
        withSecrets(secret, [], () => {
            const token = signAuthToken({ id: 42, email: "rep@example.test" });
            const payload = verifyAuthToken(token);
            assert.equal(String(payload.sub), "42");
            assert.equal(payload.email, "rep@example.test");
            assert.ok(payload.exp > payload.iat, "token must carry an expiry");

            const expired = jwt.sign({ sub: "42" }, secret, { algorithm: "HS256", expiresIn: -10 });
            assert.throws(() => verifyAuthToken(expired), /expired/i);
            const forged = jwt.sign({ sub: "42" }, strongSecret(), { algorithm: "HS256", expiresIn: "1h" });
            assert.throws(() => verifyAuthToken(forged), /signature/i);
        });
    });

    test("purpose tokens cannot be used as login tokens", () => {
        withSecrets(strongSecret(), [], () => {
            const state = signPurposeToken("hubspot_oauth_state", { sub: "7" }, "10m");
            assert.throws(() => verifyAuthToken(state));
            assert.equal(String(verifyPurposeToken(state, "hubspot_oauth_state").sub), "7");
            assert.throws(() => verifyPurposeToken(state, "n8n_campaign_send"));
        });
    });

    test("rotation: tokens signed with JWT_SECRET_PREVIOUS still verify, new tokens use the current secret", () => {
        const oldSecret = strongSecret();
        const newSecret = strongSecret();
        const oldToken = withSecrets(oldSecret, [], () => signAuthToken({ id: 9, email: "a@example.test" }));
        withSecrets(newSecret, [oldSecret], () => {
            assert.equal(String(verifyAuthToken(oldToken).sub), "9");
            const fresh = signAuthToken({ id: 9, email: "a@example.test" });
            assert.doesNotThrow(() => jwt.verify(fresh, newSecret));
        });
        withSecrets(newSecret, [], () => assert.throws(() => verifyAuthToken(oldToken)));
    });

    test("fingerprint is stable and does not reveal the secret", () => {
        const secret = strongSecret();
        const fp = secretFingerprint(secret);
        assert.equal(fp, secretFingerprint(secret));
        assert.equal(fp.length, 12);
        assert.ok(!secret.includes(fp));
    });
});

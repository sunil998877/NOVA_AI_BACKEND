import crypto from "crypto";

export const MIN_JWT_SECRET_LENGTH = 32;
const MIN_DISTINCT_CHARS = 10;
export const GENERATE_SECRET_HINT =
    "node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"";

const KNOWN_WEAK_SECRETS = new Set([
    "NOVA_AI_JWT_SECRET_9f7K2mP4xL8vQ6sR3tY5nW1aZ0cD8eF7",
    "nova-mukh-secret-key-32-chars-default!",
    "secret",
    "jwt-secret",
    "jwt_secret",
    "default-secret",
    "changeme",
]);
const PLACEHOLDER_PATTERN =
    /change[\s_-]?(me|this)|replace[\s_-]?(me|this)|your[\s_-]?(jwt[\s_-]?)?secret|default[\s_-]?secret|placeholder|example|<[^>]*>|\bsuper[\s_-]?secret\b/i;

export function validateJwtSecret(value, label = "JWT_SECRET") {
    const secret = typeof value === "string" ? value.trim() : "";
    const errors = [];
    if (!secret) {
        errors.push(`${label} is missing`);
        return { valid: false, errors };
    }
    if (secret.length < MIN_JWT_SECRET_LENGTH) {
        errors.push(`${label} must be at least ${MIN_JWT_SECRET_LENGTH} characters`);
    }
    if (new Set(secret).size < MIN_DISTINCT_CHARS) {
        errors.push(`${label} must contain at least ${MIN_DISTINCT_CHARS} distinct characters`);
    }
    if (KNOWN_WEAK_SECRETS.has(secret) || PLACEHOLDER_PATTERN.test(secret)) {
        errors.push(`${label} is a known default or placeholder value`);
    }
    return { valid: errors.length === 0, errors };
}

export function secretFingerprint(secret) {
    if (!secret) return null;
    return crypto.createHash("sha256").update(`nova-jwt-fingerprint:${secret}`).digest("hex").slice(0, 12);
}

export function resolveJwtConfig(source = process.env) {
    const current = String(source.JWT_SECRET || "").trim();
    const previous = String(source.JWT_SECRET_PREVIOUS || "").trim();
    const currentCheck = validateJwtSecret(current, "JWT_SECRET");
    const previousCheck = previous ? validateJwtSecret(previous, "JWT_SECRET_PREVIOUS") : { valid: true, errors: [] };
    const errors = [...currentCheck.errors, ...previousCheck.errors];
    if (previous && previous === current) errors.push("JWT_SECRET_PREVIOUS must differ from JWT_SECRET");
    const valid = errors.length === 0;
    return {
        valid,
        errors,
        secret: currentCheck.valid ? current : "",
        previousSecrets: previous && previousCheck.valid && previous !== current ? [previous] : [],
        fingerprint: currentCheck.valid ? secretFingerprint(current) : null,
    };
}

export class JwtConfigError extends Error {
    constructor(errors) {
        super(
            `Invalid JWT configuration: ${errors.join("; ")}. ` +
            `Set JWT_SECRET in the host environment (Render Dashboard → Environment), then redeploy. ` +
            `Generate a secret with: ${GENERATE_SECRET_HINT}`
        );
        this.name = "JwtConfigError";
        this.code = "JWT_CONFIG_INVALID";
        this.errors = errors;
    }
}

export function assertJwtConfig(source = process.env) {
    const config = resolveJwtConfig(source);
    if (!config.valid) throw new JwtConfigError(config.errors);
    return config;
}

export function enforceJwtConfigOrExit(processName = "process") {
    try {
        const config = assertJwtConfig();
        const rotation = config.previousSecrets.length ? " (rotation window: previous secret accepted for verification)" : "";
        console.log(`[Security] ${processName} JWT secret fingerprint ${config.fingerprint}${rotation}`);
        return config;
    } catch (error) {
        console.error(`[Security] ${processName} refused to start. ${error.message}`);
        process.exit(1);
    }
}

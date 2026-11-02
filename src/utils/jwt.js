import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { JwtConfigError } from "../config/jwtSecret.js";

const ALGORITHMS = ["HS256"];

function signingSecret() {
    if (!env.jwtSecret) throw new JwtConfigError(env.jwtConfigErrors?.length ? env.jwtConfigErrors : ["JWT_SECRET is missing"]);
    return env.jwtSecret;
}

function verifyWithAnySecret(token) {
    const secrets = [signingSecret(), ...(env.jwtPreviousSecrets || [])];
    let lastError = null;
    for (const secret of secrets) {
        try {
            return jwt.verify(String(token || ""), secret, { algorithms: ALGORITHMS });
        } catch (error) {
            lastError = error;
            if (error?.name === "TokenExpiredError") throw error;
        }
    }
    throw lastError || new Error("Invalid token");
}

export const signAuthToken = (user) =>
    jwt.sign(
        {
            sub: String(user._id ?? user.id),
            email: user.email,
        },
        signingSecret(),
        { expiresIn: env.jwtExpiresIn, algorithm: "HS256" }
    );

export function verifyAuthToken(token) {
    const payload = verifyWithAnySecret(token);
    if (payload?.purpose || payload?.p) {
        throw Object.assign(new Error("Token is not a login token"), { name: "JsonWebTokenError" });
    }
    if (!payload?.sub) throw Object.assign(new Error("Token has no subject"), { name: "JsonWebTokenError" });
    return payload;
}

export function signPurposeToken(purpose, claims = {}, expiresIn = "10m") {
    return jwt.sign({ ...claims, purpose }, signingSecret(), { expiresIn, algorithm: "HS256" });
}

export function verifyPurposeToken(token, purpose) {
    const payload = verifyWithAnySecret(token);
    if (payload?.purpose !== purpose) {
        throw Object.assign(new Error("Token purpose mismatch"), { name: "JsonWebTokenError" });
    }
    return payload;
}

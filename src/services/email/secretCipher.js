import crypto from "crypto";
import { env } from "../../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getDerivedKey() {
    const rawKey = process.env.EMAIL_SECRET_KEY || env.jwtSecret || "nova-mukh-secret-key-32-chars-default!";
    return crypto.createHash("sha256").update(String(rawKey)).digest();
}

export function encryptSecret(plainText) {
    if (!plainText) return "";
    const key = getDerivedKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(String(plainText), "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

export function decryptSecret(cipherText) {
    if (!cipherText) return "";
    try {
        const parts = String(cipherText).split(":");
        if (parts.length !== 3) {
            return cipherText;
        }
        const [ivHex, tagHex, encryptedHex] = parts;
        const key = getDerivedKey();
        const iv = Buffer.from(ivHex, "hex");
        const tag = Buffer.from(tagHex, "hex");
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(encryptedHex, "hex", "utf8");
        decrypted += decipher.final("utf8");
        return decrypted;
    } catch (_) {
        return "";
    }
}

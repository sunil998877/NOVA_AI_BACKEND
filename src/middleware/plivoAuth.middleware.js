import crypto from "crypto";

export function verifyPlivoSignature(req, authTokenParam = null) {
    const authToken = authTokenParam || process.env.PLIVO_AUTH_TOKEN || process.env.PLIVO_AGENT_AUTH_TOKEN;
    if (!authToken) return true;

    const headers = req.headers || {};
    const getHeader = (name) => {
        if (headers[name]) return headers[name];
        if (req.get && typeof req.get === "function") return req.get(name);
        return null;
    };

    const protocol = getHeader("x-forwarded-proto") || req.protocol || "http";
    const host = getHeader("x-forwarded-host") || getHeader("host") || "";
    const originalUrl = req.originalUrl || req.url || "";
    const fullUrl = `${protocol}://${host}${originalUrl}`;
    const method = String(req.method || "POST").toUpperCase();

    const sigV3 = getHeader("x-plivo-signature-v3");
    const nonceV3 = getHeader("x-plivo-signature-v3-nonce");

    if (sigV3 && nonceV3) {
        const baseString = `${fullUrl}${method}${nonceV3}`;
        const calculatedSig = crypto
            .createHmac("sha256", authToken)
            .update(baseString)
            .digest("base64");

        if (Buffer.byteLength(sigV3) !== Buffer.byteLength(calculatedSig)) {
            return false;
        }
        return crypto.timingSafeEqual(Buffer.from(sigV3), Buffer.from(calculatedSig));
    }

    const sigV2 = getHeader("x-plivo-signature-v2");
    const nonceV2 = getHeader("x-plivo-signature-v2-nonce");

    if (sigV2 && nonceV2) {
        const baseString = `${fullUrl}${nonceV2}`;
        const calculatedSig = crypto
            .createHmac("sha256", authToken)
            .update(baseString)
            .digest("base64");

        if (Buffer.byteLength(sigV2) !== Buffer.byteLength(calculatedSig)) {
            return false;
        }
        return crypto.timingSafeEqual(Buffer.from(sigV2), Buffer.from(calculatedSig));
    }

    const sigV1 = getHeader("x-plivo-signature");
    if (sigV1) {
        let payloadStr = "";
        const body = req.body || {};
        const sortedKeys = Object.keys(body).sort();
        for (const k of sortedKeys) {
            payloadStr += `${k}${body[k]}`;
        }

        const calculatedSig = crypto
            .createHmac("sha1", authToken)
            .update(`${fullUrl}${payloadStr}`)
            .digest("base64");

        if (Buffer.byteLength(sigV1) !== Buffer.byteLength(calculatedSig)) {
            return false;
        }
        return crypto.timingSafeEqual(Buffer.from(sigV1), Buffer.from(calculatedSig));
    }

    if (process.env.NODE_ENV === "production" && (process.env.PLIVO_AUTH_TOKEN || process.env.PLIVO_AGENT_AUTH_TOKEN)) {
        return false;
    }

    return true;
}

export function plivoWebhookAuth(req, res, next) {
    try {
        const isValid = verifyPlivoSignature(req);
        if (!isValid) {
            return res.status(401).json({ error: "Unauthorized Plivo signature verification failed" });
        }
        return next();
    } catch (_) {
        return res.status(401).json({ error: "Unauthorized invalid Plivo signature format" });
    }
}

export function agentflowWebhookAuth(req, res, next) {
    const secret = process.env.VOICE_WEBHOOK_SECRET || process.env.PLIVO_AUTH_TOKEN || process.env.PLIVO_AGENT_AUTH_TOKEN;
    const provided = req.query?.token
        || req.headers["x-webhook-secret"]
        || req.body?.token
        || req.body?.webhook_secret;
    if (secret && provided && String(provided) === String(secret)) {
        return next();
    }
    return plivoWebhookAuth(req, res, next);
}

import dotenv from "dotenv";
dotenv.config();

const parseOrigins = (value) => {
    const defaultOrigins = [
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
        "https://salmon-spoonbill-632915.hostingersite.com",
    ];
    const cleaned = String(value || "").replace(/^["']|["']$/g, "");
    const parsed = cleaned
        .split(",")
        .map((origin) => origin.trim().replace(/\/$/, ""))
        .filter(Boolean);
    return [...new Set([...defaultOrigins, ...parsed])];
};

const parseList = (value) =>
    String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

const googleClientIds = [
    ...new Set([
        ...parseList(process.env.GOOGLE_CLIENT_ID),
        ...parseList(process.env.GOOGLE_CLIENT_ID_ALT),
    ]),
];

export const env = {
    port: Number(process.env.PORT || 3000),
    nodeEnv: process.env.NODE_ENV || "development",
    mysql: {
        host: process.env.MYSQL_HOST || "127.0.0.1",
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || "root",
        password: process.env.MYSQL_PASSWORD || "",
        database: process.env.MYSQL_DATABASE || "nova_ai",
    },
    jwtSecret: process.env.JWT_SECRET || "",
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
    allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
    googleClientId: googleClientIds[0] || "",
    googleClientIds,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiAssistantId: process.env.OPENAI_ASSISTANT_ID || "",
    recaptchaSecret: process.env.RECAPTCHA_SECRET_KEY || "",
    recaptchaSiteKey:
        process.env.RECAPTCHA_SITE_KEY ||
        process.env.REACT_APP_RECAPTCHA_SITE_KEY ||
        "",
    n8nUser: process.env.N8N_USER || "",
    n8nPassword: process.env.N8N_PASSWORD || "",
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15_000),
    openaiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS || 45_000),
    n8nWebhookUrl: process.env.N8N_WEBHOOK_URL || process.env.N8N_MAIN_WEBHOOK || "",
    n8nWebhookMethod: process.env.N8N_WEBHOOK_METHOD || "POST",
    n8nMainWebhook: process.env.N8N_MAIN_WEBHOOK || process.env.N8N_WEBHOOK_URL || "",
    n8nFollowupWebhooks: {
        send_followup_1: process.env.N8N_FOLLOWUP_1_WEBHOOK || "",
        send_followup_2: process.env.N8N_FOLLOWUP_2_WEBHOOK || "",
        send_followup_3: process.env.N8N_FOLLOWUP_3_WEBHOOK || "",
        send_followup_4: process.env.N8N_FOLLOWUP_4_WEBHOOK || "",
    },
    smtp: {
        host: process.env.SMTP_HOST || "smtp.hostinger.com",
        port: Number(process.env.SMTP_PORT || 587),
        user: process.env.SMTP_USER || "",
        pass: process.env.SMTP_PASS || "",
        from: (process.env.EMAIL_FROM || process.env.SMTP_USER || "").replace(/^["']|["']$/g, ""),
    },
    novaSenderEmail: (process.env.NOVA_SENDER_EMAIL || "nova@yourdomain.com").replace(/^["']|["']$/g, "").trim(),
    novaSenderName: (process.env.NOVA_SENDER_NAME || "NOVA AI").replace(/^["']|["']$/g, "").trim(),
    frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
};

if (env.nodeEnv === "production") {
    const missing = [];
    if (!env.jwtSecret || env.jwtSecret.length < 32) missing.push("JWT_SECRET (minimum 32 characters)");
    if (!env.mysql.password) missing.push("MYSQL_PASSWORD");
    if (!process.env.ALLOWED_ORIGINS) missing.push("ALLOWED_ORIGINS");

    if (missing.length > 0) {
        throw new Error(`Missing or insecure production configuration: ${missing.join(", ")}`);
    }
}

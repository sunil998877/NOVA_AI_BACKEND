import dotenv from "dotenv";
dotenv.config({ quiet: true });

const parseOrigins = (value) => {
    const defaultOrigins = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
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

const parseMysqlConfig = () => {
    const rawUrl =
        process.env.MYSQL_PUBLIC_URL ||
        process.env.MYSQL_URL ||
        process.env.DATABASE_URL ||
        (process.env.MYSQL_HOST?.startsWith("mysql://") ? process.env.MYSQL_HOST : null);

    if (rawUrl) {
        try {
            const parsed = new URL(rawUrl);
            return {
                host: parsed.hostname,
                port: Number(parsed.port || 3306),
                user: decodeURIComponent(parsed.username || "root"),
                password: decodeURIComponent(parsed.password || ""),
                database: parsed.pathname.replace(/^\//, "") || "railway",
            };
        } catch (e) {
            console.warn("[env] Failed to parse MySQL connection URL:", e.message);
        }
    }

    let rawHost = process.env.MYSQL_HOST || process.env.MYSQLHOST || "127.0.0.1";
    rawHost = rawHost.replace(/^mysql:\/\//i, "").replace(/^https?:\/\//i, "").trim();
    if (rawHost.includes(":")) {
        const [h, p] = rawHost.split(":");
        return {
            host: h,
            port: Number(process.env.MYSQL_PORT || process.env.MYSQLPORT || p || 3306),
            user: process.env.MYSQL_USER || process.env.MYSQLUSER || "root",
            password: process.env.MYSQL_PASSWORD || process.env.MYSQLPASSWORD || "",
            database: process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE || "nova_ai",
        };
    }

    return {
        host: rawHost,
        port: Number(process.env.MYSQL_PORT || process.env.MYSQLPORT || 3306),
        user: process.env.MYSQL_USER || process.env.MYSQLUSER || "root",
        password: process.env.MYSQL_PASSWORD || process.env.MYSQLPASSWORD || "",
        database: process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE || "nova_ai",
    };
};

function isRailwayInternalHost(host) {
    return /\.railway\.internal$/i.test(String(host || ""));
}

function isLocalRedisFallbackHost(host) {
    const value = String(host || "").toLowerCase();
    return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function isReachableRedisHost(host, source = process.env) {
    if (!host) return false;
    if (isRailwayInternalHost(host) && !isOnRailway(source)) return false;
    if (/\.ngrok-free\.app$|\.ngrok\.io$/i.test(host)) return false;
    return true;
}

function isOnRailway(source = process.env) {
    return Boolean(source.RAILWAY_ENVIRONMENT || source.RAILWAY_PROJECT_ID || source.RAILWAY_SERVICE_ID);
}

function buildRedisUrl({ host, port = 6379, username, password, tls = false } = {}) {
    if (!host) return "";
    const protocol = tls ? "rediss" : "redis";
    const user = username ? encodeURIComponent(username) : "";
    const pass = password ? encodeURIComponent(password) : "";
    const auth = pass ? `${user || "default"}:${pass}@` : (user ? `${user}@` : "");
    return `${protocol}://${auth}${host}:${Number(port) || 6379}`;
}

function redisFromUrl(raw) {
    const parsed = new URL(raw);
    const tls = parsed.protocol === "rediss:";
    return {
        host: parsed.hostname,
        port: Number(parsed.port || (tls ? 6380 : 6379)),
        username: parsed.username ? decodeURIComponent(parsed.username) : "",
        password: parsed.password ? decodeURIComponent(parsed.password) : "",
        tls,
        url: raw,
    };
}

export function resolveRedisConfig(source = process.env) {
    const publicUrl = String(source.REDIS_PUBLIC_URL || source.REDIS_EXTERNAL_URL || "").trim();
    const privateUrl = String(source.REDIS_URL || source.REDIS_PRIVATE_URL || "").trim();
    const host = String(source.REDIS_HOST || source.REDISHOST || "").trim();
    const port = Number(source.REDIS_PORT || source.REDISPORT || 6379) || 6379;
    const username = String(source.REDIS_USER || source.REDISUSER || source.REDIS_USERNAME || "").trim();
    const password = String(source.REDIS_PASSWORD || source.REDISPASSWORD || "").trim();
    const publicHost = String(source.REDIS_PUBLIC_HOST || source.RAILWAY_TCP_PROXY_DOMAIN || "").trim();
    const publicPort = Number(source.REDIS_PUBLIC_PORT || source.RAILWAY_TCP_PROXY_PORT || 0);

    let parsed = null;
    const publicLooksInternal = /\.railway\.internal/i.test(publicUrl);
    const preferPublic = Boolean(publicUrl)
        && !publicLooksInternal
        && (!isOnRailway(source) || isRailwayInternalHost(host) || /\.railway\.internal/i.test(privateUrl));
    const chosenUrl = preferPublic ? publicUrl : (privateUrl || (!publicLooksInternal ? publicUrl : ""));

    if (chosenUrl) {
        try {
            parsed = redisFromUrl(chosenUrl);
        } catch {
            parsed = null;
        }
    }

    if (!parsed && host) {
        parsed = {
            host,
            port,
            username,
            password,
            tls: false,
            url: buildRedisUrl({ host, port, username, password }),
        };
    }

    if (!parsed) {
        return { url: "", host: "", port: 6379, username: "", password: "", tls: false };
    }

    if (!parsed.username && username) parsed.username = username;
    if (!parsed.password && password) parsed.password = password;

    if (!isOnRailway(source) && !isReachableRedisHost(parsed.host, source) && publicHost && isReachableRedisHost(publicHost, source)) {
        parsed.host = publicHost;
        if (publicPort) parsed.port = publicPort;
        parsed.username = username || parsed.username;
        parsed.password = password || parsed.password;
        parsed.url = buildRedisUrl({
            host: parsed.host,
            port: parsed.port,
            username: parsed.username,
            password: parsed.password,
            tls: parsed.tls,
        });
    } else {
        parsed.url = parsed.url || buildRedisUrl(parsed);
    }

    if (!isOnRailway(source) && !isReachableRedisHost(parsed.host, source) && !isLocalRedisFallbackHost(parsed.host)) {
        return {
            url: "redis://127.0.0.1:6379",
            host: "127.0.0.1",
            port: 6379,
            username: "",
            password: "",
            tls: false,
            fallbackFromInternal: true,
        };
    }

    return parsed;
}

const redis = resolveRedisConfig();
if (redis.fallbackFromInternal && typeof process.env.NODE_TEST_CONTEXT === "undefined") {
    console.warn("[Redis] REDIS_URL points at redis.railway.internal, which is not a public URL. Using redis://127.0.0.1:6379 locally.");
}

export const env = {
    port: Number(process.env.PORT || 3001),
    nodeEnv: process.env.NODE_ENV || "development",
    mysql: parseMysqlConfig(),
    jwtSecret: process.env.JWT_SECRET || "NOVA_AI_JWT_SECRET_9f7K2mP4xL8vQ6sR3tY5nW1aZ0cD8eF7",
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
    allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
    googleClientId: googleClientIds[0] || "",
    googleClientIds,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    openaiApiKey: (process.env.ASE_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim(),
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
    imap: {
        host: process.env.IMAP_HOST || (process.env.SMTP_HOST ? process.env.SMTP_HOST.replace(/^smtp\./i, "imap.") : "imap.hostinger.com"),
        port: Number(process.env.IMAP_PORT || 993),
        secure: process.env.IMAP_SECURE !== "false",
        user: process.env.IMAP_USER || process.env.SMTP_USER || "",
        pass: process.env.IMAP_PASS || process.env.SMTP_PASS || "",
        enabled: process.env.IMAP_ENABLED !== "false",
        organizationId: Number(process.env.IMAP_ORGANIZATION_ID || 0) || null,
    },
    novaSenderEmail: (process.env.NOVA_SENDER_EMAIL || "nova@yourdomain.com").replace(/^["']|["']$/g, "").trim(),
    novaSenderName: (process.env.NOVA_SENDER_NAME || "NOVA AI").replace(/^["']|["']$/g, "").trim(),
    frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
    publicApiUrl: (process.env.PUBLIC_API_URL || "").trim().replace(/\/$/, ""),
    youtubeApiKey: (process.env.YOUTUBE_API_KEY || "").trim(),
    instagramApiKey: (process.env.INSTAGRAM_API_KEY || process.env.RAPIDAPI_KEY || "").trim(),
    twitterBearerToken: (process.env.TWITTER_BEARER_TOKEN || "").trim(),
    leadsApiKey: (process.env.LEADS_API_KEY || "ase-lead-key-nova-2026").trim(),
    leadsApiUserId: (process.env.LEADS_API_USER_ID || "1").trim(),
    leadsApiOrgId: Number(process.env.LEADS_API_ORG_ID || 1),
    aseMlUrl: (process.env.ASE_ML_URL || "http://127.0.0.1:8091").trim(),
    redis,
    redisUrl: redis.url,
    queueRole: String(process.env.ASE_QUEUE_ROLE || "").trim().toLowerCase()
        || (process.env.NODE_ENV === "production" ? "api" : "all"),
    researchCacheTtlHours: Number(process.env.ASE_RESEARCH_CACHE_TTL_HOURS || 6),
    autoCallOnEmailOpen: process.env.ASE_AUTO_CALL_ON_OPEN === "true" || process.env.ASE_AUTO_CALL_ON_OPEN === "1",
    autoCallDelaySeconds: Number(process.env.ASE_AUTO_CALL_DELAY_SECONDS || 30),
    callAfterFirstEmailDelayMinutes: Number(process.env.ASE_CALL_AFTER_FIRST_EMAIL_DELAY_MINUTES || 15),
    autoCallReviewMode: process.env.ASE_AUTO_CALL_REVIEW_MODE === "true" || process.env.ASE_AUTO_CALL_REVIEW_MODE === "1",
    allowBotOpenCall: process.env.ASE_ALLOW_BOT_OPEN_CALL === "true",
    callingHoursStart: Number(process.env.ASE_CALLING_HOURS_START || 9),
    callingHoursEnd: Number(process.env.ASE_CALLING_HOURS_END || 20),
    callingTimezone: process.env.ASE_CALLING_TIMEZONE || "Asia/Kolkata",
    emailsPerHour: Number(process.env.ASE_EMAILS_PER_HOUR || 60),
    callsPerHour: Number(process.env.ASE_CALLS_PER_HOUR || 20),
    quietDays: Number(process.env.ASE_QUIET_DAYS || 14),
    bypassTimingGates: process.env.ASE_BYPASS_TIMING_GATES === "true"
        || process.env.ASE_BYPASS_TIMING_GATES === "1"
        || (
            process.env.ASE_BYPASS_TIMING_GATES !== "false"
            && process.env.NODE_ENV !== "production"
            && process.env.NODE_ENV !== "test"
            && typeof process.env.NODE_TEST_CONTEXT === "undefined"
        ),
};

if (env.nodeEnv === "production") {
    const missing = [];
    if (!env.jwtSecret || env.jwtSecret.length < 32) missing.push("JWT_SECRET (minimum 32 characters)");
    if (!env.mysql.password) missing.push("MYSQL_PASSWORD");
    if (!process.env.ALLOWED_ORIGINS) missing.push("ALLOWED_ORIGINS");
    if (!process.env.LEADS_API_KEY || env.leadsApiKey === "ase-lead-key-nova-2026") missing.push("LEADS_API_KEY");
    if (!process.env.PUBLIC_API_URL) missing.push("PUBLIC_API_URL");

    if (missing.length > 0) {
        console.warn(`[env] Insecure or missing production configuration: ${missing.join(", ")}`);
    }
}

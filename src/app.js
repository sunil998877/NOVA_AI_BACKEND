import express from "express";
import cors from "cors";
import JSON5 from "json5";
import { env } from "./config/env.js";
import authRoutes from "./routes/auth.routes.js";
import campaignRoutes from "./routes/campaign.routes.js";
import mailRoutes from "./routes/mail.routes.js";
import statRoutes from "./routes/stat.routes.js";
import conversationRoutes from "./routes/conversation.routes.js";
import openaiRoutes from "./routes/openai.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";
import sheetsRoutes from "./routes/sheets.routes.js";
import influencerRoutes from "./routes/influencer.routes.js";
import contactRoutes from "./routes/contact.routes.js";
import trackRoutes from "./routes/track.routes.js";
import collaborationRoutes from "./routes/collaboration.routes.js";
import leadRoutes from "./routes/lead.routes.js";
import callbackRoutes from "./routes/callback.routes.js";
import suppressionRoutes from "./routes/suppression.routes.js";
import aseVoiceRoutes from "./routes/ase-voice.routes.js";
import senderAccountRoutes from "./routes/sender-account.routes.js";
import followUpRoutes from "./routes/followUp.routes.js";
import playbookRoutes from "./routes/playbook.routes.js";
import aseOperatingRoutes from "./routes/ase-operating.routes.js";
import { handleN8nChatEvent } from "./controllers/Webhook/n8n-chat.controller.js";
import { runAseIntegrationTests } from "./tests/ase_integration.test.js";
import { emailReplyListener } from "./services/ase/emailReplyListener.service.js";

export const app = express();

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            const normalized = origin.replace(/\/$/, "");
            if (
                env.nodeEnv !== "production" ||
                env.allowedOrigins.includes(normalized) ||
                env.allowedOrigins.includes(origin) ||
                normalized.includes("localhost") ||
                normalized.includes("127.0.0.1") ||
                normalized.endsWith(".onrender.com") ||
                normalized.includes("onrender.com") ||
                normalized.endsWith(".vercel.app") ||
                normalized.includes("vercel.app") ||
                normalized.endsWith(".hostingersite.com")
            ) {
                return callback(null, true);
            }
            return callback(null, false);
        },
        credentials: true,
        methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
            "X-Requested-With",
            "Accept",
            "X-Frontend-Url",
            "x-api-key",
            "x-organization-id",
        ],
    })
);

const parseJsonBody = (raw) => {
    const text = String(raw || "").trim();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return JSON5.parse(text);
    }
};

app.use("/api/leads/import-csv", express.json({ limit: "6mb" }));

app.use(
    express.json({
        limit: "2mb",
        verify: (req, _res, buf) => {
            req.rawBody = buf.toString("utf8");
        },
    })
);
app.use((err, req, res, next) => {
    const isJsonParseError =
        err instanceof SyntaxError &&
        (err.type === "entity.parse.failed" || err.status === 400) &&
        typeof req.rawBody === "string";

    if (!isJsonParseError) {
        return next(err);
    }

    try {
        req.body = parseJsonBody(req.rawBody);
        return next();
    } catch {
        return res.status(400).json({
            error:
                "Invalid JSON. Use double quotes for keys, no trailing commas, and no // comments — or send a JSON5 object.",
        });
    }
});
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
    req.body = req.body || {};
    next();
});

app.get("/", (_req, res) => {
    res.status(200).send("Backend is running");
});

app.get("/api/health", (_req, res) => {
    res.status(200).json({ ok: true });
});

app.get("/api/engine/test", async (_req, res) => {
    try {
        const results = await runAseIntegrationTests();
        const passed = results.filter((r) => r.passed).length;
        res.status(200).json({ total: results.length, passed, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.use("/api/auth", authRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/mails", mailRoutes);
app.use("/api/stats", statRoutes);
app.use("/api/conversations", conversationRoutes);
app.use("/api/openai", openaiRoutes);
app.use("/api/webhook", webhookRoutes);
app.use("/api/google-sheets", sheetsRoutes);
app.use("/api/influencers", influencerRoutes);
app.use("/api/contacts", contactRoutes);
app.use("/api/track", trackRoutes);
app.use("/api/tracking", trackRoutes);
app.use("/api/collab", collaborationRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/engine/leads", leadRoutes);
app.use("/api/callbacks", callbackRoutes);
app.use("/api/suppressions", suppressionRoutes);
app.use("/api/engine/voice", aseVoiceRoutes);
app.use("/api/sender-accounts", senderAccountRoutes);
app.use("/api/follow-ups", followUpRoutes);
app.use("/api/playbook", playbookRoutes);
app.use("/api/ase", aseOperatingRoutes);
app.post("/api/webhooks/n8n/chat-event", handleN8nChatEvent);

app.all("/api/engine/check-email-replies", async (_req, res) => {
    try {
        const result = await emailReplyListener.pollInbox();
        res.status(200).json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/engine/inbound-email", async (req, res) => {
    try {
        const payload = req.body || {};
        const from = payload.from || payload.sender || payload.from_email || payload.envelope?.from || "";
        const subject = payload.subject || "";
        const body = payload.body || payload.text || payload.html || payload.message || payload.reply || "";
        const messageId = payload.messageId || payload["message-id"] || `webhook_${Date.now()}`;
        const date = payload.date ? new Date(payload.date) : new Date();

        const result = await emailReplyListener.handleIncomingReply({
            from,
            subject,
            body,
            rawText: body,
            messageId,
            date,
        });

        if (!result) {
            return res.status(200).json({ ok: false, message: "Lead not found for sender" });
        }
        res.status(200).json({ ok: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.use((err, _req, res, _next) => {
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
        return res.status(400).json({
            error:
                "Invalid JSON. Use double quotes for keys, no trailing commas, and no // comments.",
        });
    }
    console.error(err.stack);
    const message =
        env.nodeEnv === "production" ? "Internal server error" : err.message;
    res.status(500).json({ error: message });
});

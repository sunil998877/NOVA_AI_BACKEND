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

export const app = express();

app.use(
    cors({
        origin: env.nodeEnv === "production" ? env.allowedOrigins : true,
        credentials: true,
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

app.get("/health", (_req, res) => {
    res.status(200).send("Backend is running");
});

app.get("/api/health", (_req, res) => {
    res.status(200).json({ ok: true });
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

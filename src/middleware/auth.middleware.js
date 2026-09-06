import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User } from "../models/user.model.js";
import { toPublicUser } from "../utils/user.js";
import { verifyCampaignSendToken } from "../utils/campaign-send-token.js";

const bearerToken = (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
    const queryToken = req.query?.accessToken || req.query?.token;
    if (queryToken) return String(queryToken);
    const headerKey = req.headers["x-n8n-token"] || req.headers["x-access-token"];
    if (headerKey) return String(headerKey);
    return "";
};

const matchesN8nBasicAuth = (req) => {
    if (!env.n8nUser || !env.n8nPassword) return false;
    const header = req.headers.authorization;
    if (!header?.startsWith("Basic ")) return false;
    try {
        const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
        const sep = decoded.indexOf(":");
        if (sep < 0) return false;
        const user = decoded.slice(0, sep);
        const pass = decoded.slice(sep + 1);
        return user === env.n8nUser && pass === env.n8nPassword;
    } catch {
        return false;
    }
};

export const authenticate = async (req, res, next) => {
    try {
        const token = bearerToken(req);
        if (!token) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        if (!env.jwtSecret) {
            return res.status(500).json({ error: "JWT_SECRET is not configured" });
        }

        const campaignSend = verifyCampaignSendToken(token);
        if (campaignSend) {
            const user = campaignSend.userId ? await User.findById(campaignSend.userId) : null;
            req.n8nCampaignId = campaignSend.campaignId;
            req.authVia = "n8n_campaign_token";
            if (user) {
                const publicUser = toPublicUser(user);
                req.user = { ...publicUser, id: String(user.id) };
            } else {
                req.user = { id: campaignSend.userId || "n8n" };
            }
            return next();
        }

        const payload = jwt.verify(token, env.jwtSecret);
        const user = await User.findById(payload.sub);

        if (!user) {
            return res.status(401).json({ error: "Invalid token" });
        }

        const publicUser = toPublicUser(user);
        req.user = {
            ...publicUser,
            id: String(user.id),
        };
        req.authVia = "user_jwt";
        return next();
    } catch {
        return res.status(401).json({ error: "Invalid token" });
    }
};


export const authenticateUserOrN8n = async (req, res, next) => {
    if (matchesN8nBasicAuth(req)) {
        req.authVia = "n8n_basic";
        req.user = { id: "n8n" };
        return next();
    }
    return authenticate(req, res, next);
};

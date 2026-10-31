import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { User } from "../models/user.model.js";
import { toPublicUser } from "../utils/user.js";
import { verifyCampaignSendToken } from "../utils/campaign-send-token.js";
import { ASE_ADMIN_ROLES, ASE_ROLES, roleAllowed, scopedOrgId } from "../services/ase/roles.constants.js";

const USER_CACHE_TTL_MS = 5 * 60 * 1000;
const userCache = new Map();

function getCachedUser(id) {
    const entry = userCache.get(String(id));
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        userCache.delete(String(id));
        return null;
    }
    return entry.user;
}

function setCachedUser(id, user) {

    if (userCache.size >= 500) {
        userCache.delete(userCache.keys().next().value);
    }
    userCache.set(String(id), { user, expiresAt: Date.now() + USER_CACHE_TTL_MS });
}

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
            let user = campaignSend.userId ? getCachedUser(campaignSend.userId) : null;
            if (!user && campaignSend.userId) {
                user = await User.findById(campaignSend.userId);
                if (user) setCachedUser(campaignSend.userId, user);
            }
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

        let user = getCachedUser(payload.sub);
        if (!user) {
            user = await User.findById(payload.sub);
            if (user) setCachedUser(payload.sub, user);
        }

        if (!user) {
            return res.status(401).json({ error: "Invalid token" });
        }

        const publicUser = toPublicUser(user);
        req.user = {
            ...publicUser,
            id: String(user.id),
            organization_id: scopedOrgId(user) || 1,
            role: user.role || "ORG_ADMIN",
        };
        req.authVia = "user_jwt";
        return next();
    } catch {
        return res.status(401).json({ error: "Invalid token" });
    }
};

export const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        if (!roleAllowed(req.user.role, roles)) {
            return res.status(403).json({
                error: `Forbidden: role ${req.user.role} does not have permission for this action`,
            });
        }
        return next();
    };
};

export const requireOrg = (req, res, next) => {
    const orgId = scopedOrgId(req.user);
    if (!orgId) {
        return res.status(403).json({ error: "User is not bound to an organization" });
    }
    req.user.organization_id = orgId;
    return next();
};

function chain(...middlewares) {
    return (req, res, next) => {
        let index = 0;
        const run = (err) => {
            if (err) return next(err);
            const layer = middlewares[index++];
            if (!layer) return next();
            layer(req, res, run);
        };
        run();
    };
}

export const requireAseRole = chain(requireOrg, requireRole(...ASE_ROLES));
export const requireAseAdmin = chain(requireOrg, requireRole(...ASE_ADMIN_ROLES));

export const authenticateUserOrN8n = async (req, res, next) => {
    if (matchesN8nBasicAuth(req)) {
        req.authVia = "n8n_basic";
        const orgId = Number(req.headers["x-organization-id"] || process.env.N8N_ORGANIZATION_ID || 1);
        req.user = { id: "n8n", organization_id: orgId, role: "SYSTEM_AGENT" };
        return next();
    }
    return authenticate(req, res, next);
};


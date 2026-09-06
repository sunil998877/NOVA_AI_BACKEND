import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const PURPOSE = "n8n_campaign_send";

export const signCampaignSendToken = ({ campaignId, userId }) => {
    if (!env.jwtSecret) {
        throw new Error("JWT_SECRET is not configured");
    }

    return jwt.sign(
        {
            purpose: PURPOSE,
            campaignId: String(campaignId),
            sub: String(userId),
        },
        env.jwtSecret,
        { expiresIn: "6h" }
    );
};

export const verifyCampaignSendToken = (token) => {
    if (!env.jwtSecret || !token) return null;
    try {
        const payload = jwt.verify(token, env.jwtSecret);
        if (payload?.purpose !== PURPOSE || !payload.campaignId) return null;
        return {
            campaignId: String(payload.campaignId),
            userId: String(payload.sub || ""),
        };
    } catch {
        return null;
    }
};

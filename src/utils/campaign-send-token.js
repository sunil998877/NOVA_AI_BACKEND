import { signPurposeToken, verifyPurposeToken } from "./jwt.js";

const PURPOSE = "n8n_campaign_send";

export const signCampaignSendToken = ({ campaignId, userId }) =>
    signPurposeToken(PURPOSE, { campaignId: String(campaignId), sub: String(userId) }, "6h");

export const verifyCampaignSendToken = (token) => {
    if (!token) return null;
    try {
        const payload = verifyPurposeToken(token, PURPOSE);
        if (!payload.campaignId) return null;
        return {
            campaignId: String(payload.campaignId),
            userId: String(payload.sub || ""),
        };
    } catch {
        return null;
    }
};

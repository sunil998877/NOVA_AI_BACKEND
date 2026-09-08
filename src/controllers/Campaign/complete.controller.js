import { Campaign } from "../../models/campaign.model.js";
import { audit } from "../../utils/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { forceCompleteCampaign } from "../../services/campaign-reconcile.service.js";

export const completeCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.campaignId || req.params.id || req.body?.campaignId;
    if (!campaignId || campaignId === "undefined" || campaignId === "null") {
        return res.status(400).json({ error: "Missing or invalid campaignId in request URL" });
    }

    let campaign;
    if (req.authVia === "n8n_basic") {
        campaign = await Campaign.findById(campaignId);
    } else if (req.authVia === "n8n_campaign_token") {
        if (String(req.n8nCampaignId) !== String(campaignId)) {
            return res.status(403).json({ error: "Token is not valid for this campaign" });
        }
        campaign = await Campaign.findById(campaignId);
    } else {
        campaign = await Campaign.findOwned(campaignId, req.user.id);
    }

    if (!campaign) {
        return res.status(403).json({ error: "Access denied: You do not own this campaign" });
    }

    const markMails = req.body?.markMails !== false;
    const updated = await forceCompleteCampaign(campaign, { markMails });

    await audit(req.user.id, "CAMPAIGN_COMPLETE", campaign.id, req.ip);

    return res.status(200).json({
        success: true,
        campaignId: updated.id,
        status: updated.status,
        totalRecipients: updated.total_recipients,
        sent: updated.sent_count,
        failed: updated.failed_count,
        message: "Campaign marked as completed",
        campaign: updated,
    });
});

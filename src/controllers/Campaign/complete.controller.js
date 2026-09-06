import { Campaign } from "../../models/campaign.model.js";
import { audit } from "../../utils/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { forceCompleteCampaign } from "../../services/campaign-reconcile.service.js";

export const completeCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.campaignId || req.params.id;
    const campaign = await Campaign.findOwned(campaignId, req.user.id);

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

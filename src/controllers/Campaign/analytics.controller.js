import { Campaign } from "../../models/campaign.model.js";
import { EmailEvent } from "../../models/email-event.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const getCampaignAnalytics = asyncHandler(async (req, res) => {
    const campaignId = req.params.campaignId || req.params.id;
    const campaign = await Campaign.findOwned(campaignId, req.user.id);

    if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
    }

    const analytics = await EmailEvent.getCampaignAnalytics(campaign.id);

    return res.status(200).json({
        ...analytics,
        title: campaign.title,
    });
});

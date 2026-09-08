import { CampaignRecipient } from "../../models/campaignRecipient.model.js";
import { Campaign } from "../../models/campaign.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const listCampaignRecipients = asyncHandler(async (req, res) => {
    const { campaignId } = req.params;

    const campaign = await Campaign.findOwned(campaignId, req.user.id);
    if (!campaign) {
        return res.status(403).json({ error: "Access denied" });
    }

    const recipients = await CampaignRecipient.listByCampaign(campaign.id);
    const total = await CampaignRecipient.countByCampaign(campaign.id);

    return res.status(200).json({ data: recipients, total });
});

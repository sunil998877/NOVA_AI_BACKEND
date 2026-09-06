import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const deleteMailsByCampaign = asyncHandler(async (req, res) => {
    const campaign = await Campaign.findOwned(req.params.id, req.user.id);
    if (!campaign) {
        return res.status(403).json({ error: "Access denied: You do not own this campaign" });
    }

    const deleted = await Mail.deleteByCampaignId(campaign.id);
    return res.status(200).json({ success: true, deleted });
});

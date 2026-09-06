import { Campaign } from "../../models/campaign.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const getCampaign = asyncHandler(async (req, res) => {
    const campaign = await Campaign.findOwned(req.params.id, req.user.id);
    if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
    }
    return res.status(200).json(campaign);
});

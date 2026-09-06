import { Campaign } from "../../models/campaign.model.js";
import { audit } from "../../utils/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const deleteCampaign = asyncHandler(async (req, res) => {
    const existing = await Campaign.findOwned(req.params.id, req.user.id);
    if (!existing) {
        return res.status(403).json({ error: "Access denied: You do not own this campaign" });
    }

    await Campaign.deleteById(existing.id);
    await audit(req.user.id, "CAMPAIGN_DELETE", req.params.id, req.ip);
    return res.status(200).json({ success: true });
});

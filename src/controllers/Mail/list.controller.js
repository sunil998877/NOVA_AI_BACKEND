import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const listMails = asyncHandler(async (req, res) => {
    const campaignId = req.query.campaignId;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
    const skip = (page - 1) * limit;
    const ids = await Campaign.listIdsByUser(req.user.id);

    if (campaignId && !ids.some((id) => String(id) === String(campaignId))) {
        return res.status(403).json({ error: "Access denied" });
    }

    const [data, total] = await Promise.all([
        Mail.findForUserCampaigns(ids, campaignId, { skip, limit }),
        Mail.countForUserCampaigns(ids, campaignId),
    ]);
    return res.status(200).json({ data, total, page, limit });
});

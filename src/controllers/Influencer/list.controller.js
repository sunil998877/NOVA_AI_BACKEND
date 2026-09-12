import { Influencer } from "../../models/influencer.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const listInfluencers = asyncHandler(async (req, res) => {
    try {
        const data = await Influencer.findByUser(req.user.id);
        return res.status(200).json({ data: data || [] });
    } catch (err) {
        console.error("listInfluencers error:", err.message);
        return res.status(200).json({ data: [] });
    }
});


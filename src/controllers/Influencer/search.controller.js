import { influencerService } from "../../services/influencer.service.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const searchInfluencers = asyncHandler(async (req, res) => {
    const {
        q,
        platform = "youtube",
        pageToken,
        maxResults = 12,
        minSubscribers,
        maxSubscribers,
    } = req.query;

    try {
        const result = await influencerService.search({
            platform,
            q,
            pageToken,
            maxResults: Number(maxResults) || 12,
            minSubscribers,
            maxSubscribers,
        });

        if (result?.error) {
            return res.status(200).json({
                success: false,
                ...result,
            });
        }

        return res.status(200).json({
            success: true,
            ...result,
        });
    } catch (err) {
        return res.status(200).json({
            success: false,
            platform,
            data: [],
            error: err.message || "Failed to discover influencers",
        });
    }
});

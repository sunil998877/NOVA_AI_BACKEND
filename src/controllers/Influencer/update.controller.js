import { Influencer } from "../../models/influencer.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const updateInfluencer = asyncHandler(async (req, res) => {
    const existing = await Influencer.findOwned(req.params.id, req.user.id);
    if (!existing) {
        return res.status(404).json({ error: "Influencer not found" });
    }

    const {
        name,
        handle,
        platform,
        followers,
        engagement,
        niche,
        location,
        avatar,
        verified,
        status,
        notes,
        lastContact,
    } = req.body;

    const updated = await Influencer.updateById(existing.id, {
        name,
        handle,
        platform,
        followers,
        engagement,
        niche,
        location,
        avatar,
        verified,
        status,
        notes,
        lastContact,
    });

    return res.status(200).json(updated);
});

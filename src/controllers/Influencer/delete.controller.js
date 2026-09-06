import { Influencer } from "../../models/influencer.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const deleteInfluencer = asyncHandler(async (req, res) => {
    const existing = await Influencer.findOwned(req.params.id, req.user.id);
    if (!existing) {
        return res.status(404).json({ error: "Influencer not found" });
    }

    await Influencer.deleteById(existing.id);
    return res.status(200).json({ success: true });
});

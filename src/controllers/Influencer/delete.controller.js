import { Influencer } from "../../models/influencer.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const deleteInfluencer = asyncHandler(async (req, res) => {
    const success = await Influencer.remove(req.params.id, req.user.id);
    if (!success) {
        return res.status(404).json({ error: "Influencer not found" });
    }
    return res.status(200).json({ success: true });
});

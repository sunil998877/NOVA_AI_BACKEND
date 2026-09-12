import { Influencer } from "../../models/influencer.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const createInfluencer = asyncHandler(async (req, res) => {
    const { name } = req.body;

    if (!name) {
        return res.status(400).json({ error: "Influencer name is required" });
    }

    try {
        const saved = await Influencer.upsertAndSave(req.user.id, req.body);
        return res.status(201).json(saved);
    } catch (err) {
        console.error("createInfluencer error:", err);
        return res.status(500).json({ error: err.message || "Failed to save influencer" });
    }
});

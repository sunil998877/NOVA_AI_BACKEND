import { Influencer } from "../../models/influencer.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const updateInfluencer = asyncHandler(async (req, res) => {
    const existing = await Influencer.findOwned(req.params.id, req.user.id);
    if (!existing) {
        return res.status(404).json({ error: "Influencer not found" });
    }

    const { status, notes, lastContact, email } = req.body;
    const updated = await Influencer.updateStatus(existing.id, req.user.id, {
        status,
        notes,
        lastContact,
        email,
    });

    return res.status(200).json(updated);
});

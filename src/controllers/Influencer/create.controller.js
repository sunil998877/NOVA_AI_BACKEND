import { Influencer } from "../../models/influencer.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const createInfluencer = asyncHandler(async (req, res) => {
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

    if (!name) {
        return res.status(400).json({ error: "Influencer name is required" });
    }

    if (handle) {
        const existing = await Influencer.findByUserAndHandle(req.user.id, handle);
        if (existing) {
            return res.status(200).json(existing);
        }
    }

    const influencer = await Influencer.create({
        user_id: req.user.id,
        name,
        handle: handle ?? null,
        platform: platform ?? null,
        followers: followers ?? null,
        engagement: engagement ?? null,
        niche: niche ?? null,
        location: location ?? null,
        avatar: avatar ?? null,
        verified: Boolean(verified),
        status: status || "saved",
        notes: notes ?? null,
        lastContact: lastContact ?? new Date(),
    });

    return res.status(201).json(influencer);
});

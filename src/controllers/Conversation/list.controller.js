import { Conversation } from "../../models/conversation.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const listConversations = asyncHandler(async (req, res) => {
    const data = await Conversation.findByUser(req.user.id);
    return res.status(200).json({ data });
});

import { Conversation } from "../../models/conversation.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { FIFTEEN_DAYS_MS } from "./constants.js";

export const createConversation = asyncHandler(async (req, res) => {
    const { title, thread_id } = req.body;
    const conversation = await Conversation.create({
        user_id: req.user.id,
        title: title || "New conversation",
        thread_id: thread_id || null,
        expiresAt: new Date(Date.now() + FIFTEEN_DAYS_MS),
    });
    return res.status(201).json(conversation);
});

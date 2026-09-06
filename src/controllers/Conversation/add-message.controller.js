import { Conversation } from "../../models/conversation.model.js";
import { Message } from "../../models/message.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { FIFTEEN_DAYS_MS } from "./constants.js";

export const addMessage = asyncHandler(async (req, res) => {
    const conversation = await Conversation.findOwned(req.params.id, req.user.id);
    if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
    }

    const { role, content } = req.body;
    if (!role || !content) {
        return res.status(400).json({ error: "role and content are required" });
    }

    const message = await Message.create({
        conversation_id: conversation.id,
        user_id: req.user.id,
        role,
        content,
    });
    await Conversation.updateById(conversation.id, {
        expiresAt: new Date(Date.now() + FIFTEEN_DAYS_MS),
    });
    return res.status(201).json(message);
});

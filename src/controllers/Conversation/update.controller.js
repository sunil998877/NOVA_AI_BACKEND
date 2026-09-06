import { Conversation } from "../../models/conversation.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const updateConversation = asyncHandler(async (req, res) => {
    const conversation = await Conversation.findOwned(req.params.id, req.user.id);
    if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
    }

    const updated = await Conversation.updateById(conversation.id, {
        ...(req.body.title ? { title: req.body.title } : {}),
        ...(req.body.thread_id !== undefined ? { thread_id: req.body.thread_id } : {}),
    });
    return res.status(200).json(updated);
});

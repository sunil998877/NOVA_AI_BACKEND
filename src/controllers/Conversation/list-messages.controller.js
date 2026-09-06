import { Conversation } from "../../models/conversation.model.js";
import { Message } from "../../models/message.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const listMessages = asyncHandler(async (req, res) => {
    const conversation = await Conversation.findOwned(req.params.id, req.user.id);
    if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
    }
    const data = await Message.findByConversation(conversation.id);
    return res.status(200).json({ data });
});

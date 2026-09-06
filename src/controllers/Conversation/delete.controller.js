import { Conversation } from "../../models/conversation.model.js";
import { Message } from "../../models/message.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const deleteConversation = asyncHandler(async (req, res) => {
    const conversation = await Conversation.findOwned(req.params.id, req.user.id);
    if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
    }
    await Message.deleteByConversationId(conversation.id);
    await Conversation.deleteById(conversation.id);
    return res.status(200).json({ success: true });
});

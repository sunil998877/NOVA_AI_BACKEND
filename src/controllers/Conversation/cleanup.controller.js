import { Conversation } from "../../models/conversation.model.js";
import { Message } from "../../models/message.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const cleanupConversations = asyncHandler(async (req, res) => {
    const ids = await Conversation.findExpiredIds(req.user.id);
    await Message.deleteByConversationIds(ids);
    const deleted = await Conversation.deleteByIds(ids);
    return res.status(200).json({ success: true, deleted });
});

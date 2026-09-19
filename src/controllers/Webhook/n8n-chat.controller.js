import { asyncHandler } from "../../utils/asyncHandler.js";
import { Message } from "../../models/message.model.js";
import { Conversation } from "../../models/conversation.model.js";
import { CollaborationMessage } from "../../models/collaboration-message.model.js";
import { getIo } from "../../socket/socketServer.js";
import { env } from "../../config/env.js";

export const handleN8nChatEvent = asyncHandler(async (req, res) => {
    const secret =
        req.headers["x-n8n-secret"] ||
        req.headers["x-webhook-secret"] ||
        req.query?.secret ||
        "";

    const expectedSecret = process.env.N8N_WEBHOOK_SECRET || env.n8nPassword;
    if (expectedSecret && secret !== expectedSecret) {
        return res.status(401).json({ error: "Unauthorized: Invalid webhook secret" });
    }

    const {
        conversationId,
        senderType = "influencer",
        senderName = "Creator",
        message,
        messageType = "text",
    } = req.body || {};

    if (!conversationId) {
        return res.status(400).json({ error: "conversationId is required" });
    }

    if (!message || !String(message).trim()) {
        return res.status(400).json({ error: "message content is required" });
    }

    const cleanText = String(message).trim();

    let savedMsg = null;
    try {
        savedMsg = await Message.create({
            conversationId,
            senderId: null,
            senderType,
            message: cleanText,
            messageType,
        });
    } catch (_) {}

    try {
        await CollaborationMessage.create({
            collaborationId,
            senderType: senderType === "user" ? "marketer" : "influencer",
            senderName,
            content: cleanText,
        });
    } catch (_) {}

    try {
        await Conversation.updateLastMessage(conversationId, savedMsg?.id, new Date());
    } catch (_) {}

    const formattedMsg = {
        id: savedMsg?.id || Date.now(),
        conversationId: Number(conversationId),
        senderId: null,
        senderType,
        senderName,
        message: cleanText,
        content: cleanText,
        messageType,
        isRead: false,
        createdAt: savedMsg?.createdAt || new Date().toISOString(),
    };

    const io = getIo();
    if (io) {
        io.to(`conversation:${conversationId}`).emit("newMessage", formattedMsg);
        io.emit("conversation:updated", {
            conversationId: Number(conversationId),
            lastMessage: cleanText,
            lastMessageAt: formattedMsg.createdAt,
            lastSenderType: senderType,
        });
    }

    return res.status(200).json({
        success: true,
        message: formattedMsg,
    });
});

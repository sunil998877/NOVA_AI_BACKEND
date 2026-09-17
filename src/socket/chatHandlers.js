import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";
import { Collaboration } from "../models/collaboration.model.js";
import { CollaborationMessage } from "../models/collaboration-message.model.js";
import { presence } from "./presence.js";

/**
 * Register Socket.IO chat event handlers for a connected socket
 */
export function registerChatHandlers(io, socket) {
    const user = socket.user;
    if (!user) return;

    // Track presence
    const isFirstConnection = presence.add(user.id, socket.id);
    if (isFirstConnection) {
        io.emit("user:online", { userId: user.id, role: user.role });
    }

    // Send current online users to this socket
    socket.emit("presence:state", {
        onlineUserIds: presence.getOnlineUserIds(),
    });

    /**
     * 1. Join Conversation Room
     */
    socket.on("joinConversation", async ({ conversationId }, callback) => {
        try {
            if (!conversationId) {
                const errPayload = { error: "Conversation ID is required" };
                socket.emit("error", errPayload);
                if (typeof callback === "function") callback(errPayload);
                return;
            }

            // Verify access
            let authorized = false;
            let conv = await Conversation.findForParticipant(conversationId, user);
            if (conv) {
                authorized = true;
            } else {
                // Check if conversationId refers to collaboration_history
                if (user.role === "user") {
                    const collab = await Collaboration.findById(conversationId, user.id);
                    if (collab) authorized = true;
                } else if (user.role === "influencer") {
                    if (String(user.collabId) === String(conversationId)) {
                        authorized = true;
                    }
                }
            }

            if (!authorized) {
                const errPayload = { error: "Access denied: You are not a participant in this conversation" };
                socket.emit("error", errPayload);
                if (typeof callback === "function") callback(errPayload);
                return;
            }

            const room = `conversation:${conversationId}`;
            socket.join(room);

            const successPayload = { success: true, conversationId: Number(conversationId), room };
            socket.emit("joinedConversation", successPayload);
            if (typeof callback === "function") callback(null, successPayload);
        } catch (err) {
            console.error("[Socket] joinConversation error:", err.message);
            if (typeof callback === "function") callback({ error: err.message });
        }
    });

    /**
     * 2. Send Message
     */
    socket.on("sendMessage", async (payload, callback) => {
        try {
            const { conversationId, message, messageType = "text", tempId = null } = payload || {};

            if (!conversationId) {
                const errPayload = { error: "Conversation ID is required" };
                if (typeof callback === "function") callback(errPayload);
                return;
            }

            const text = String(message || "").trim();
            if (!text) {
                const errPayload = { error: "Message content cannot be empty" };
                if (typeof callback === "function") callback(errPayload);
                return;
            }

            if (text.length > 5000) {
                const errPayload = { error: "Message exceeds maximum length of 5000 characters" };
                if (typeof callback === "function") callback(errPayload);
                return;
            }

            const room = `conversation:${conversationId}`;

            let savedMessage = null;
            try {
                savedMessage = await Message.create({
                    conversationId,
                    senderId: user.role === "user" ? user.userId || user.id : null,
                    senderType: user.senderType,
                    message: text,
                    messageType,
                });
            } catch (e) {
                console.warn("[Socket] Message.create fallback:", e.message);
            }

            try {
                const targetCollabId = user.collabId || conversationId;
                await CollaborationMessage.create({
                    collaborationId: targetCollabId,
                    senderType: user.senderType === "user" ? "marketer" : "influencer",
                    senderName: user.name || (user.senderType === "user" ? "Marketer" : "Creator"),
                    content: text,
                });
            } catch (_) {}

            try {
                await Conversation.updateLastMessage(conversationId, savedMessage?.id, new Date());
            } catch (_) {}

            const formattedMsg = {
                id: savedMessage?.id || Date.now(),
                conversationId: Number(conversationId),
                senderId: user.role === "user" ? Number(user.id) : null,
                senderType: user.senderType, // 'user' | 'influencer'
                senderName: user.name || (user.senderType === "user" ? "Marketer" : "Creator"),
                message: text,
                content: text,
                messageType,
                isRead: false,
                createdAt: savedMessage?.createdAt || new Date().toISOString(),
                tempId, // Echo temporary ID so sender replaces optimistic UI message
            };

            // Broadcast to all participants in the conversation room
            io.to(room).emit("newMessage", formattedMsg);

            // Notify all user tabs of conversation list update
            io.emit("conversation:updated", {
                conversationId: Number(conversationId),
                lastMessage: text,
                lastMessageAt: formattedMsg.createdAt,
                lastSenderType: user.senderType,
            });

            if (typeof callback === "function") {
                callback(null, { success: true, message: formattedMsg });
            }
        } catch (err) {
            console.error("[Socket] sendMessage error:", err);
            if (typeof callback === "function") callback({ error: err.message });
        }
    });

    /**
     * 3. Typing Indicators
     */
    socket.on("typing:start", ({ conversationId }) => {
        if (!conversationId) return;
        socket.to(`conversation:${conversationId}`).emit("typing:start", {
            conversationId: Number(conversationId),
            userId: user.id,
            userName: user.name,
            senderType: user.senderType,
        });
    });

    socket.on("typing:stop", ({ conversationId }) => {
        if (!conversationId) return;
        socket.to(`conversation:${conversationId}`).emit("typing:stop", {
            conversationId: Number(conversationId),
            userId: user.id,
        });
    });

    /**
     * 4. Read Receipts
     */
    socket.on("message:read", async ({ conversationId }) => {
        if (!conversationId) return;
        try {
            await Message.markAsRead(conversationId, user.senderType);
            try {
                await CollaborationMessage.markAsRead(
                    conversationId,
                    user.senderType === "user" ? "marketer" : "influencer"
                );
            } catch (_) {}

            io.to(`conversation:${conversationId}`).emit("messages:read", {
                conversationId: Number(conversationId),
                readBy: user.id,
                readerType: user.senderType,
                readAt: new Date().toISOString(),
            });
        } catch (err) {
            console.error("[Socket] message:read error:", err.message);
        }
    });

    /**
     * 5. Disconnect Handler
     */
    socket.on("disconnect", () => {
        const isOffline = presence.remove(socket.id);
        if (isOffline) {
            io.emit("user:offline", { userId: user.id });
        }
    });
}

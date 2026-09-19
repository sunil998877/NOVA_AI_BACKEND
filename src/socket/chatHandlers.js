import { Conversation } from "../models/conversation.model.js";
import { Message } from "../models/message.model.js";
import { Collaboration } from "../models/collaboration.model.js";
import { CollaborationMessage } from "../models/collaboration-message.model.js";
import { presence } from "./presence.js";

export function registerChatHandlers(io, socket) {
    const user = socket.user;
    if (!user) return;

    const isFirstConnection = presence.add(user.id, socket.id);
    if (user.collabId) {
        presence.add(String(user.collabId), socket.id);
        presence.add(`inf-${user.collabId}`, socket.id);
    }
    if (user.influencerId) {
        presence.add(String(user.influencerId), socket.id);
    }

    if (isFirstConnection) {
        io.emit("user:online", { userId: user.id, role: user.role });
        if (user.collabId) {
            io.emit("user:online", { userId: String(user.collabId), role: user.role });
            io.emit("user:online", { userId: `inf-${user.collabId}`, role: user.role });
        }
        if (user.influencerId) {
            io.emit("user:online", { userId: String(user.influencerId), role: user.role });
        }
    }

    socket.emit("presence:state", {
        onlineUserIds: presence.getOnlineUserIds(),
    });

    socket.on("joinConversation", async ({ conversationId }, callback) => {
        try {
            if (!conversationId) {
                const errPayload = { error: "Conversation ID is required" };
                socket.emit("error", errPayload);
                if (typeof callback === "function") callback(errPayload);
                return;
            }

            let authorized = false;
            let conv = await Conversation.findForParticipant(conversationId, user);
            if (conv) {
                authorized = true;
            } else {
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

            const explicitSenderType = payload?.senderType || payload?.sender_type;
            const resolvedSenderType =
                explicitSenderType === "influencer" || explicitSenderType === "creator"
                    ? "influencer"
                    : (user.role === "influencer" || user.senderType === "influencer" ? "influencer" : "user");

            const resolvedSenderTypeDb = resolvedSenderType === "influencer" ? "influencer" : "marketer";
            const resolvedSenderName =
                payload?.senderName ||
                payload?.sender_name ||
                user.name ||
                (resolvedSenderTypeDb === "influencer" ? "Creator" : "Marketer");

            const targetCollabId = user.collabId || conversationId;

            const [savedMessage] = await Promise.all([
                Message.create({
                    conversationId,
                    senderId: user.role === "user" ? user.userId || user.id : null,
                    senderType: resolvedSenderType,
                    message: text,
                    messageType,
                }).catch((e) => {
                    console.warn("[Socket] Message.create fallback:", e.message);
                    return null;
                }),
                CollaborationMessage.create({
                    collaborationId: targetCollabId,
                    senderType: resolvedSenderTypeDb,
                    senderName: resolvedSenderName,
                    content: text,
                }).catch(() => null),
            ]);

            if (savedMessage?.id) {
                Conversation.updateLastMessage(conversationId, savedMessage.id, new Date()).catch(() => {});
            }

            const formattedMsg = {
                id: savedMessage?.id || Date.now(),
                conversationId: Number(conversationId),
                senderId: user.role === "user" ? Number(user.id) : null,
                senderType: resolvedSenderType,
                sender_type: resolvedSenderTypeDb,
                senderName: resolvedSenderName,
                sender_name: resolvedSenderName,
                message: text,
                content: text,
                messageType,
                isRead: false,
                createdAt: savedMessage?.createdAt || new Date().toISOString(),
                tempId,
            };

            io.to(room).emit("newMessage", formattedMsg);

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

    socket.on("disconnect", () => {
        const isOffline = presence.remove(socket.id);
        if (isOffline) {
            io.emit("user:offline", { userId: user.id });
        }
    });
}

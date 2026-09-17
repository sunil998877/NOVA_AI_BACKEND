import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import {
    listUserConversations,
    getConversationDetails,
    createOrFindConversation,
    getConversationMessages,
    markConversationRead,
} from "../controllers/Conversation/conversation.controller.js";
import { createConversation as createAiConversation } from "../controllers/Conversation/create.controller.js";
import { listMessages as listAiMessages } from "../controllers/Conversation/list-messages.controller.js";
import { addMessage as addAiMessage } from "../controllers/Conversation/add-message.controller.js";
import { updateConversation } from "../controllers/Conversation/update.controller.js";
import { deleteConversation } from "../controllers/Conversation/delete.controller.js";
import { cleanupConversations } from "../controllers/Conversation/cleanup.controller.js";

const router = Router();

// 1. Unified Conversations List:
// Serves real-time influencer conversations by default, or OpenAI thread if ?type=ai is specified
router.get("/", authenticate, async (req, res, next) => {
    if (req.query.type === "ai") {
        const { listConversations } = await import("../controllers/Conversation/list.controller.js");
        return listConversations(req, res, next);
    }
    return listUserConversations(req, res, next);
});

// 2. Create / Find Conversation
router.post("/", authenticate, async (req, res, next) => {
    // If it's an AI thread from Message Crafter (has thread_id or title === 'Message Crafter')
    if (req.body.thread_id || req.body.title === "Message Crafter" || req.query.type === "ai") {
        return createAiConversation(req, res, next);
    }
    return createOrFindConversation(req, res, next);
});

// 3. Mark Conversation Messages as Read
router.post("/:conversationId/read", authenticate, markConversationRead);

// 4. Conversation Messages (with pagination ?before=...&limit=50)
router.get("/:conversationId/messages", authenticate, async (req, res, next) => {
    if (req.query.type === "ai") {
        return listAiMessages(req, res, next);
    }
    return getConversationMessages(req, res, next);
});

router.post("/:conversationId/messages", authenticate, async (req, res, next) => {
    if (req.query.type === "ai") {
        return addAiMessage(req, res, next);
    }
    // Fallback to sending message via REST
    const { Message } = await import("../models/message.model.js");
    const { message, content } = req.body;
    const text = message || content;
    const newMsg = await Message.create({
        conversationId: req.params.conversationId,
        senderId: req.user.id,
        senderType: "user",
        message: text,
    });
    return res.status(201).json({ success: true, data: newMsg });
});

// 5. Get Single Conversation Details
router.get("/:conversationId", authenticate, getConversationDetails);

// 6. Maintenance & Legacy routes
router.post("/cleanup", authenticate, cleanupConversations);
router.patch("/:id", authenticate, updateConversation);
router.delete("/:id", authenticate, deleteConversation);

export default router;

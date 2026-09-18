import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import {
    getPortalByToken,
    sendPortalMessage,
    getMarketerMessages,
    sendMarketerMessage,
    getMarketerConversations,
    getChatCount,
} from "../controllers/Influencer/collaboration-portal.controller.js";

const router = Router();

router.get("/portal/:token", getPortalByToken);
router.post("/portal/:token/message", sendPortalMessage);

router.get("/conversations", authenticate, getMarketerConversations);
router.get("/chat-count", authenticate, getChatCount);
router.get("/:id/messages", authenticate, getMarketerMessages);
router.post("/:id/messages", authenticate, sendMarketerMessage);

export default router;

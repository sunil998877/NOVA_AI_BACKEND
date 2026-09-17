import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import {
    getPortalByToken,
    sendPortalMessage,
    getMarketerMessages,
    sendMarketerMessage,
    getMarketerConversations,
} from "../controllers/Influencer/collaboration-portal.controller.js";

const router = Router();

// Public Creator Portal routes
router.get("/portal/:token", getPortalByToken);
router.post("/portal/:token/message", sendPortalMessage);

// Authenticated Marketer routes
router.get("/conversations", authenticate, getMarketerConversations);
router.get("/:id/messages", authenticate, getMarketerMessages);
router.post("/:id/messages", authenticate, sendMarketerMessage);

export default router;

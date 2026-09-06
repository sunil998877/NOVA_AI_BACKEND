import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { createConversation } from "../controllers/Conversation/create.controller.js";
import { listConversations } from "../controllers/Conversation/list.controller.js";
import { listMessages } from "../controllers/Conversation/list-messages.controller.js";
import { addMessage } from "../controllers/Conversation/add-message.controller.js";
import { updateConversation } from "../controllers/Conversation/update.controller.js";
import { deleteConversation } from "../controllers/Conversation/delete.controller.js";
import { cleanupConversations } from "../controllers/Conversation/cleanup.controller.js";

const router = Router();

router.post("/", authenticate, createConversation);
router.get("/", authenticate, listConversations);
router.post("/cleanup", authenticate, cleanupConversations);
router.get("/:id/messages", authenticate, listMessages);
router.post("/:id/messages", authenticate, addMessage);
router.patch("/:id", authenticate, updateConversation);
router.delete("/:id", authenticate, deleteConversation);

export default router;

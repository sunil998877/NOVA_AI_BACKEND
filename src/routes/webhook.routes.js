import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { proxyWebhook } from "../controllers/Webhook/proxy.controller.js";

const router = Router();

router.get("/", authenticate, proxyWebhook);
router.post("/", authenticate, proxyWebhook);

export default router;

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../middleware/auth.middleware.js";
import { generateMessage } from "../controllers/OpenAI/generate-message.controller.js";
import { generateFollowups } from "../controllers/OpenAI/generate-followups.controller.js";

const router = Router();

const openaiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});

router.post("/generate-message", authenticate, openaiLimiter, generateMessage);
router.post("/generate-followups", authenticate, openaiLimiter, generateFollowups);

export default router;

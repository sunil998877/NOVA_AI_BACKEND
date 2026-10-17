import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { getCallback, listCallbacks, updateCallback } from "../controllers/Callback/callback.controller.js";

const router = Router();

router.get("/", authenticate, listCallbacks);
router.get("/:id", authenticate, getCallback);
router.patch("/:id", authenticate, updateCallback);

export default router;

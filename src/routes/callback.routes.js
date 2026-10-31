import { Router } from "express";
import { authenticate, requireAseRole } from "../middleware/auth.middleware.js";
import {
    getCallback,
    getCallbackVoiceCall,
    listCallbacks,
    startCallbackVoiceCall,
    updateCallback,
} from "../controllers/Callback/callback.controller.js";

const router = Router();

router.get("/", authenticate, requireAseRole, listCallbacks);
router.post("/:id/call", authenticate, requireAseRole, startCallbackVoiceCall);
router.get("/:id/call", authenticate, requireAseRole, getCallbackVoiceCall);
router.get("/:id", authenticate, requireAseRole, getCallback);
router.patch("/:id", authenticate, requireAseRole, updateCallback);

export default router;

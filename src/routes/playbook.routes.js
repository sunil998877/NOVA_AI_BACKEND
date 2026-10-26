import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { getPlaybook, savePlaybook, previewPlaybook } from "../controllers/Playbook/playbook.controller.js";

const router = Router();

router.get("/", authenticate, getPlaybook);
router.put("/", authenticate, savePlaybook);
router.post("/preview", authenticate, previewPlaybook);

export default router;

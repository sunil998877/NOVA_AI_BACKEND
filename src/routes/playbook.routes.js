import { Router } from "express";
import { authenticate, requireAseAdmin } from "../middleware/auth.middleware.js";
import { getPlaybook, savePlaybook, previewPlaybook } from "../controllers/Playbook/playbook.controller.js";

const router = Router();

router.get("/", authenticate, requireAseAdmin, getPlaybook);
router.put("/", authenticate, requireAseAdmin, savePlaybook);
router.post("/preview", authenticate, requireAseAdmin, previewPlaybook);

export default router;

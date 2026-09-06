import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { sheetsNotConfigured } from "../controllers/Sheets/not-configured.controller.js";

const router = Router();

router.post("/append-campaign", authenticate, sheetsNotConfigured);
router.post("/update-followups", authenticate, sheetsNotConfigured);
router.post("/get-campaign", authenticate, sheetsNotConfigured);
router.post("/get-existing-followups", authenticate, sheetsNotConfigured);

export default router;

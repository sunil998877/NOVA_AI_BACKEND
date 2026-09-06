import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { getPerformance } from "../controllers/Stat/performance.controller.js";

const router = Router();

router.get("/performance", authenticate, getPerformance);

export default router;

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate, requireAseAdmin, requireAseRole } from "../../../middleware/auth.middleware.js";
import { getLeadIntelligence, previewIntelligence, refreshLeadIntelligence } from "../controllers/intelligence.controller.js";

const router = Router();

const researchLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    keyGenerator: (req) => `intel:${req.user?.organization_id || "anon"}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: "RATE_LIMITED", message: "Too many research requests; try again in a minute" } },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get("/leads/:leadId", authenticate, requireAseRole, wrap(getLeadIntelligence));
router.post("/leads/:leadId/refresh", authenticate, requireAseRole, researchLimiter, wrap(refreshLeadIntelligence));
router.post("/preview", authenticate, requireAseAdmin, researchLimiter, wrap(previewIntelligence));

export default router;

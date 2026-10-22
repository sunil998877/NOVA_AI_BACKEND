import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate } from "../middleware/auth.middleware.js";
import { authenticateLeadApi } from "../middleware/leadApiKey.middleware.js";
import { ingestLeadsFromApi } from "../controllers/Lead/api-intake.controller.js";
import { importCsv, previewCsv } from "../controllers/Lead/csv-import.controller.js";
import { deleteLead, getLead, leadStats, listLeads, updateLead, getApiCaptureConfig, rotateApiCaptureKey, executeLeadAction, listTeamReps, draftLeadEmail } from "../controllers/Lead/manage.controller.js";
import { getLeadDecision, getLeadConversionPrediction, getBrainStatus, updateBrainMode, getBrainEvaluation } from "../controllers/Lead/brain.controller.js";

const router = Router();

const leadIngestLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many lead ingestion requests. Try again in a minute." },
});

router.post("/", leadIngestLimiter, authenticateLeadApi, ingestLeadsFromApi);
router.post("/webhook", leadIngestLimiter, authenticateLeadApi, ingestLeadsFromApi);

router.post("/import-csv/preview", authenticate, previewCsv);
router.post("/import-csv", authenticate, importCsv);

router.get("/api-config", authenticate, getApiCaptureConfig);
router.post("/api-key/rotate", authenticate, rotateApiCaptureKey);

router.get("/brain/status", authenticate, getBrainStatus);
router.post("/brain/mode", authenticate, updateBrainMode);
router.get("/brain/evaluation", authenticate, getBrainEvaluation);

router.get("/", authenticate, listLeads);
router.get("/team-reps", authenticate, listTeamReps);
router.get("/stats", authenticate, leadStats);
router.get("/:id/decision", authenticate, getLeadDecision);
router.get("/:id/conversion-prediction", authenticate, getLeadConversionPrediction);
router.get("/:id", authenticate, getLead);
router.post("/:id/execute", authenticate, executeLeadAction);
router.post("/:id/draft-email", authenticate, draftLeadEmail);
router.patch("/:id", authenticate, updateLead);
router.delete("/:id", authenticate, deleteLead);

export default router;

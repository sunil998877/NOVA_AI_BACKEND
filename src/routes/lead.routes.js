import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticate, requireAseAdmin, requireAseRole } from "../middleware/auth.middleware.js";
import { authenticateLeadApi } from "../middleware/leadApiKey.middleware.js";
import { ingestLeadsFromApi } from "../controllers/Lead/api-intake.controller.js";
import { getImportJob, importCsv, listImportJobs, previewCsv } from "../controllers/Lead/csv-import.controller.js";
import { deleteLead, getLead, leadStats, listLeads, updateLead, getApiCaptureConfig, rotateApiCaptureKey, executeLeadAction, listTeamReps, draftLeadEmail } from "../controllers/Lead/manage.controller.js";
import { exportAseReportsCsv, getAseReports, getComplianceLog, listSegments } from "../controllers/Lead/reports.controller.js";
import { getLeadDecision, getLeadConversionPrediction, getBrainStatus, updateBrainMode, getBrainEvaluation, getOperatingModeStatus, updateOperatingMode } from "../controllers/Lead/brain.controller.js";
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

router.post("/import-csv/preview", authenticate, requireAseRole, previewCsv);
router.post("/import-csv", authenticate, requireAseRole, importCsv);
router.get("/import-jobs", authenticate, requireAseRole, listImportJobs);
router.get("/import-jobs/:id", authenticate, requireAseRole, getImportJob);

router.get("/api-config", authenticate, requireAseAdmin, getApiCaptureConfig);
router.post("/api-key/rotate", authenticate, requireAseAdmin, rotateApiCaptureKey);

router.get("/brain/status", authenticate, requireAseRole, getBrainStatus);
router.post("/brain/mode", authenticate, requireAseAdmin, updateBrainMode);
router.get("/brain/evaluation", authenticate, requireAseAdmin, getBrainEvaluation);
router.get("/operating-mode", authenticate, requireAseRole, getOperatingModeStatus);
router.post("/operating-mode", authenticate, requireAseAdmin, updateOperatingMode);

router.get("/", authenticate, requireAseRole, listLeads);
router.get("/team-reps", authenticate, requireAseRole, listTeamReps);
router.get("/stats", authenticate, requireAseRole, leadStats);
router.get("/reports", authenticate, requireAseRole, getAseReports);
router.get("/reports.csv", authenticate, requireAseRole, exportAseReportsCsv);
router.get("/reports/compliance", authenticate, requireAseAdmin, getComplianceLog);
router.get("/segments", authenticate, requireAseRole, listSegments);
router.get("/:id/decision", authenticate, requireAseRole, getLeadDecision);
router.get("/:id/conversion-prediction", authenticate, requireAseRole, getLeadConversionPrediction);
router.get("/:id", authenticate, requireAseRole, getLead);
router.post("/:id/execute", authenticate, requireAseRole, executeLeadAction);
router.post("/:id/draft-email", authenticate, requireAseRole, draftLeadEmail);
router.patch("/:id", authenticate, requireAseRole, updateLead);
router.delete("/:id", authenticate, requireAseAdmin, deleteLead);

export default router;

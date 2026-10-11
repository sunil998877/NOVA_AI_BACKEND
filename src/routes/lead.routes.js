import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { authenticateLeadApi } from "../middleware/leadApiKey.middleware.js";
import { ingestLeadsFromApi } from "../controllers/Lead/api-intake.controller.js";
import { importCsv, previewCsv } from "../controllers/Lead/csv-import.controller.js";
import { deleteLead, getLead, leadStats, listLeads, updateLead, getApiCaptureConfig } from "../controllers/Lead/manage.controller.js";

const router = Router();

// Input 1 — API (x-api-key or user JWT)
router.post("/", authenticateLeadApi, ingestLeadsFromApi);
router.post("/webhook", authenticateLeadApi, ingestLeadsFromApi);

// Input 2 — CSV import
router.post("/import-csv/preview", authenticate, previewCsv);
router.post("/import-csv", authenticate, importCsv);

// Configuration for API / Webhook Capture
router.get("/api-config", authenticate, getApiCaptureConfig);

// Management
router.get("/", authenticate, listLeads);
router.get("/stats", authenticate, leadStats);
router.get("/:id", authenticate, getLead);
router.patch("/:id", authenticate, updateLead);
router.delete("/:id", authenticate, deleteLead);

export default router;

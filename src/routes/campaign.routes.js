import { Router } from "express";
import { authenticate, authenticateUserOrN8n } from "../middleware/auth.middleware.js";
import { listCampaigns } from "../controllers/Campaign/list.controller.js";
import { getCampaign } from "../controllers/Campaign/get.controller.js";
import { createCampaign } from "../controllers/Campaign/create.controller.js";
import { updateCampaign } from "../controllers/Campaign/update.controller.js";
import { updateCampaignStatus } from "../controllers/Campaign/update-status.controller.js";
import { sendCampaign } from "../controllers/Campaign/send.controller.js";
import { completeCampaign } from "../controllers/Campaign/complete.controller.js";
import { deleteCampaign } from "../controllers/Campaign/delete.controller.js";
import { listCampaignRecipients } from "../controllers/CampaignRecipient/list.controller.js";
import { addCampaignRecipients } from "../controllers/CampaignRecipient/add.controller.js";
import { removeCampaignRecipient } from "../controllers/CampaignRecipient/remove.controller.js";
import { previewCampaign } from "../controllers/Campaign/preview.controller.js";
import { getCampaignAnalytics } from "../controllers/Campaign/analytics.controller.js";

const router = Router();

router.get("/list", authenticate, listCampaigns);
router.post("/create", authenticate, createCampaign);
router.get("/:campaignId/analytics", authenticate, getCampaignAnalytics);
router.get("/:campaignId/recipients", authenticate, listCampaignRecipients);
router.post("/:campaignId/recipients", authenticate, addCampaignRecipients);
router.delete("/:campaignId/recipients/:contactId", authenticate, removeCampaignRecipient);
router.post("/:campaignId/send", authenticate, sendCampaign);
router.post("/:campaignId/complete", authenticateUserOrN8n, completeCampaign);
router.patch("/:campaignId/status", authenticateUserOrN8n, updateCampaignStatus);
router.get("/:id/preview", authenticate, previewCampaign);
router.get("/:id", authenticate, getCampaign);
router.put("/:id", authenticate, updateCampaign);
router.patch("/:id", authenticateUserOrN8n, updateCampaign);
router.delete("/:id", authenticate, deleteCampaign);

export default router;


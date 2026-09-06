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

const router = Router();

router.get("/list", authenticate, listCampaigns);
router.post("/create", authenticate, createCampaign);
router.post("/:campaignId/send", authenticate, sendCampaign);
router.post("/:campaignId/complete", authenticate, completeCampaign);
router.patch("/:campaignId/status", authenticateUserOrN8n, updateCampaignStatus);
router.get("/:id", authenticate, getCampaign);
router.put("/:id", authenticate, updateCampaign);
router.patch("/:id", authenticate, updateCampaign);
router.delete("/:id", authenticate, deleteCampaign);

export default router;

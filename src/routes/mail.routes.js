import { Router } from "express";
import { authenticate, authenticateUserOrN8n } from "../middleware/auth.middleware.js";
import { listMails } from "../controllers/Mail/list.controller.js";
import { listMailsByCampaign } from "../controllers/Mail/list-by-campaign.controller.js";
import { batchCreateMails } from "../controllers/Mail/batch-create.controller.js";
import { updateMailStatus } from "../controllers/Mail/update-status.controller.js";
import { deleteMailsByCampaign } from "../controllers/Mail/delete-by-campaign.controller.js";

const router = Router();

router.get("/", authenticate, listMails);
router.get("/campaign/:id", authenticateUserOrN8n, listMailsByCampaign);
router.post("/batch", authenticate, batchCreateMails);
router.patch("/:id", authenticateUserOrN8n, updateMailStatus);
router.delete("/campaign/:id", authenticate, deleteMailsByCampaign);

export default router;

import { Router } from "express";
import { trackOpen, trackClick } from "../controllers/Track/tracking.controller.js";

const router = Router();

router.get("/open/:campaignId/:recipientId", trackOpen);
router.get("/click/:campaignId/:recipientId", trackClick);
router.get("/open/:mailId", trackOpen);
router.get("/click/:mailId", trackClick);

export default router;

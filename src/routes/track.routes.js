import { Router } from "express";
import { trackOpen, trackClick, trackUnsubscribe } from "../controllers/Track/tracking.controller.js";

const router = Router();

router.get("/open/:campaignId/:recipientId", trackOpen);
router.get("/click/:campaignId/:recipientId", trackClick);
router.get("/open/:token", trackOpen);
router.get("/click/:token", trackClick);
router.get("/unsubscribe/:campaignId/:recipientId", trackUnsubscribe);
router.get("/unsubscribe", trackUnsubscribe);

export default router;

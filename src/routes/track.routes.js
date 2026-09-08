import { Router } from "express";
import { trackOpen, trackClick } from "../controllers/Track/track.controller.js";

const router = Router();

router.get("/open/:mailId", trackOpen);
router.get("/click/:mailId", trackClick);

export default router;

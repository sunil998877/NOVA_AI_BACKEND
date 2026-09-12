import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { listInfluencers } from "../controllers/Influencer/list.controller.js";
import { createInfluencer } from "../controllers/Influencer/create.controller.js";
import { updateInfluencer } from "../controllers/Influencer/update.controller.js";
import { deleteInfluencer } from "../controllers/Influencer/delete.controller.js";
import { searchInfluencers } from "../controllers/Influencer/search.controller.js";
import { sendInfluencerOutreach } from "../controllers/Influencer/outreach.controller.js";
import {
    listCollaborations,
    getCollaboration,
    updateCollaboration,
    deleteCollaboration,
} from "../controllers/Influencer/collaboration.controller.js";

const router = Router();

router.get("/search", authenticate, searchInfluencers);
router.get("/youtube/search", authenticate, searchInfluencers);
router.post("/outreach", authenticate, sendInfluencerOutreach);

router.get("/collaborations", authenticate, listCollaborations);
router.get("/collaborations/:id", authenticate, getCollaboration);
router.patch("/collaborations/:id", authenticate, updateCollaboration);
router.delete("/collaborations/:id", authenticate, deleteCollaboration);

router.get("/", authenticate, listInfluencers);
router.post("/", authenticate, createInfluencer);
router.patch("/:id", authenticate, updateInfluencer);
router.delete("/:id", authenticate, deleteInfluencer);

export default router;

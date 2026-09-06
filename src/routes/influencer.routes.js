import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { listInfluencers } from "../controllers/Influencer/list.controller.js";
import { createInfluencer } from "../controllers/Influencer/create.controller.js";
import { updateInfluencer } from "../controllers/Influencer/update.controller.js";
import { deleteInfluencer } from "../controllers/Influencer/delete.controller.js";

const router = Router();

router.get("/", authenticate, listInfluencers);
router.post("/", authenticate, createInfluencer);
router.patch("/:id", authenticate, updateInfluencer);
router.delete("/:id", authenticate, deleteInfluencer);

export default router;

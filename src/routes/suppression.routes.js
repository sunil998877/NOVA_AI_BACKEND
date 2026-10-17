import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { addSuppression, listSuppressions, removeSuppression } from "../controllers/Suppression/suppression.controller.js";

const router = Router();

router.get("/", authenticate, listSuppressions);
router.post("/", authenticate, addSuppression);
router.delete("/:id", authenticate, removeSuppression);

export default router;

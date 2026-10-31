import { Router } from "express";
import { authenticate, requireAseAdmin, requireAseRole } from "../middleware/auth.middleware.js";
import { addSuppression, listSuppressions, removeSuppression } from "../controllers/Suppression/suppression.controller.js";

const router = Router();

router.get("/", authenticate, requireAseRole, listSuppressions);
router.post("/", authenticate, requireAseAdmin, addSuppression);
router.delete("/:id", authenticate, requireAseAdmin, removeSuppression);

export default router;

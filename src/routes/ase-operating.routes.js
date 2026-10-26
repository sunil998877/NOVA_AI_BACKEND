import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { getOperatingModeStatus, updateOperatingMode } from "../controllers/Ase/operating-mode.controller.js";
import {
    approveById,
    approveLeadAction,
    getLeadPendingApproval,
    holdById,
    holdLeadAction,
    listOrgApprovals,
} from "../controllers/Ase/approval.controller.js";

const router = Router();

router.get("/operating-mode", authenticate, getOperatingModeStatus);
router.put("/operating-mode", authenticate, updateOperatingMode);
router.post("/operating-mode", authenticate, updateOperatingMode);

router.get("/approvals", authenticate, listOrgApprovals);
router.get("/approvals/lead/:leadId", authenticate, getLeadPendingApproval);
router.post("/approvals/lead/:leadId/approve", authenticate, approveLeadAction);
router.post("/approvals/lead/:leadId/hold", authenticate, holdLeadAction);
router.post("/approvals/:id/approve", authenticate, approveById);
router.post("/approvals/:id/hold", authenticate, holdById);

export default router;

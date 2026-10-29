import { Router } from "express";
import { authenticate, requireAseAdmin, requireAseRole } from "../middleware/auth.middleware.js";
import { createInvite, listInvites } from "../controllers/Ase/invite.controller.js";
import { getAsePresence, setAsePresence } from "../controllers/Ase/presence.controller.js";
import { getOperatingModeStatus, updateOperatingMode } from "../controllers/Ase/operating-mode.controller.js";
import {
    approveById,
    approveLeadAction,
    getLeadPendingApproval,
    holdById,
    holdLeadAction,
    listOrgApprovals,
    unholdLeadAction,
} from "../controllers/Ase/approval.controller.js";
import { getQueueStatus } from "../controllers/Ase/queue.controller.js";

const router = Router();

router.get("/queues", authenticate, requireAseAdmin, getQueueStatus);
router.get("/operating-mode", authenticate, requireAseRole, getOperatingModeStatus);
router.put("/operating-mode", authenticate, requireAseAdmin, updateOperatingMode);
router.post("/operating-mode", authenticate, requireAseAdmin, updateOperatingMode);

router.get("/invites", authenticate, requireAseAdmin, listInvites);
router.post("/invites", authenticate, requireAseAdmin, createInvite);

router.get("/presence", authenticate, requireAseRole, getAsePresence);
router.post("/presence", authenticate, requireAseRole, setAsePresence);

router.get("/approvals", authenticate, requireAseRole, listOrgApprovals);
router.get("/approvals/lead/:leadId", authenticate, requireAseRole, getLeadPendingApproval);
router.post("/approvals/lead/:leadId/approve", authenticate, requireAseRole, approveLeadAction);
router.post("/approvals/lead/:leadId/hold", authenticate, requireAseRole, holdLeadAction);
router.post("/approvals/lead/:leadId/unhold", authenticate, requireAseRole, unholdLeadAction);
router.post("/approvals/:id/approve", authenticate, requireAseRole, approveById);
router.post("/approvals/:id/hold", authenticate, requireAseRole, holdById);

export default router;

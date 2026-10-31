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
import { getClickToCallById, getLeadClickToCall, startLeadClickToCall } from "../controllers/Ase/clickToCall.controller.js";
import {
    approveStep,
    createPolicy,
    enrollLeadInCadence,
    getCadenceQueue,
    getDefaultPolicy,
    getLeadCadenceState,
    getLeadEligibility,
    listPolicies,
    pauseLeadCadence,
    rejectStep,
    resolveReview,
    resumeLeadCadence,
    stopLeadCadence,
    updatePolicy,
} from "../controllers/Ase/cadence.controller.js";

const router = Router();

router.get("/queues", authenticate, requireAseAdmin, getQueueStatus);
router.get("/operating-mode", authenticate, requireAseRole, getOperatingModeStatus);
router.put("/operating-mode", authenticate, requireAseAdmin, updateOperatingMode);
router.post("/operating-mode", authenticate, requireAseAdmin, updateOperatingMode);

router.get("/invites", authenticate, requireAseAdmin, listInvites);
router.post("/invites", authenticate, requireAseAdmin, createInvite);

router.get("/presence", authenticate, requireAseRole, getAsePresence);
router.post("/presence", authenticate, requireAseRole, setAsePresence);

router.post("/leads/:leadId/call", authenticate, requireAseRole, startLeadClickToCall);
router.get("/leads/:leadId/call", authenticate, requireAseRole, getLeadClickToCall);
router.get("/calls/:callId", authenticate, requireAseRole, getClickToCallById);

router.get("/approvals", authenticate, requireAseRole, listOrgApprovals);
router.get("/approvals/lead/:leadId", authenticate, requireAseRole, getLeadPendingApproval);
router.post("/approvals/lead/:leadId/approve", authenticate, requireAseRole, approveLeadAction);
router.post("/approvals/lead/:leadId/hold", authenticate, requireAseRole, holdLeadAction);
router.post("/approvals/lead/:leadId/unhold", authenticate, requireAseRole, unholdLeadAction);
router.post("/approvals/:id/approve", authenticate, requireAseRole, approveById);
router.post("/approvals/:id/hold", authenticate, requireAseRole, holdById);

router.get("/cadence/policies", authenticate, requireAseRole, listPolicies);
router.get("/cadence/policies/default", authenticate, requireAseRole, getDefaultPolicy);
router.post("/cadence/policies", authenticate, requireAseAdmin, createPolicy);
router.put("/cadence/policies/:policyId", authenticate, requireAseAdmin, updatePolicy);
router.get("/cadence/queue", authenticate, requireAseRole, getCadenceQueue);
router.get("/cadence/leads/:leadId", authenticate, requireAseRole, getLeadCadenceState);
router.get("/cadence/leads/:leadId/eligibility", authenticate, requireAseRole, getLeadEligibility);
router.post("/cadence/leads/:leadId/enroll", authenticate, requireAseRole, enrollLeadInCadence);
router.post("/cadence/leads/:leadId/pause", authenticate, requireAseRole, pauseLeadCadence);
router.post("/cadence/leads/:leadId/resume", authenticate, requireAseRole, resumeLeadCadence);
router.post("/cadence/leads/:leadId/stop", authenticate, requireAseRole, stopLeadCadence);
router.post("/cadence/steps/:stepId/approve", authenticate, requireAseRole, approveStep);
router.post("/cadence/steps/:stepId/reject", authenticate, requireAseRole, rejectStep);
router.post("/cadence/steps/:stepId/review", authenticate, requireAseRole, resolveReview);

export default router;

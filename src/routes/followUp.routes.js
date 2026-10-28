import { Router } from "express";
import { authenticate, requireAseAdmin, requireAseRole } from "../middleware/auth.middleware.js";
import {
    listSequences,
    getSequence,
    createSequence,
    updateSequence,
    deleteSequence,
    listEnrollments,
    getEnrollment,
    enrollLead,
    pauseEnrollment,
    resumeEnrollment,
    stopEnrollment,
    cancelEnrollment,
    markReplyProcessed,
    listReplies,
    listBlockedTasks,
    getLeadJourney,
    previewTaskContent,
    updateTask,
    retryTask,
    getAutomationStatus,
    startAutomation,
    pauseAutomation,
    resumeAutomation,
    stopAutomation,
} from "../controllers/FollowUp/followUp.controller.js";

const router = Router();
router.use(authenticate, requireAseRole);

router.get("/sequences", listSequences);
router.post("/sequences", requireAseAdmin, createSequence);
router.get("/sequences/:id", getSequence);
router.patch("/sequences/:id", requireAseAdmin, updateSequence);
router.delete("/sequences/:id", requireAseAdmin, deleteSequence);

router.get("/automation/status", getAutomationStatus);
router.post("/automation/start", requireAseAdmin, startAutomation);
router.post("/automation/pause", requireAseAdmin, pauseAutomation);
router.post("/automation/resume", requireAseAdmin, resumeAutomation);
router.post("/automation/stop", requireAseAdmin, stopAutomation);

router.get("/enrollments", listEnrollments);
router.post("/enrollments", enrollLead);
router.get("/enrollments/:id", getEnrollment);
router.patch("/enrollments/:id/pause", pauseEnrollment);
router.post("/enrollments/:id/pause", pauseEnrollment);
router.patch("/enrollments/:id/resume", resumeEnrollment);
router.post("/enrollments/:id/resume", resumeEnrollment);
router.patch("/enrollments/:id/stop", stopEnrollment);
router.post("/enrollments/:id/stop", stopEnrollment);
router.patch("/enrollments/:id/cancel", cancelEnrollment);
router.post("/enrollments/:id/cancel", cancelEnrollment);
router.patch("/enrollments/:id/mark-processed", markReplyProcessed);
router.post("/enrollments/:id/mark-processed", markReplyProcessed);

router.get("/replies", listReplies);
router.get("/blocked-tasks", listBlockedTasks);

router.get("/leads/:leadId", getLeadJourney);

router.get("/tasks/:id/preview", previewTaskContent);
router.patch("/tasks/:id", updateTask);
router.post("/tasks/:id/retry", retryTask);

export default router;

import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
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

router.get("/sequences", authenticate, listSequences);
router.post("/sequences", authenticate, createSequence);
router.get("/sequences/:id", authenticate, getSequence);
router.patch("/sequences/:id", authenticate, updateSequence);
router.delete("/sequences/:id", authenticate, deleteSequence);

router.get("/automation/status", authenticate, getAutomationStatus);
router.post("/automation/start", authenticate, startAutomation);
router.post("/automation/pause", authenticate, pauseAutomation);
router.post("/automation/resume", authenticate, resumeAutomation);
router.post("/automation/stop", authenticate, stopAutomation);

router.get("/enrollments", authenticate, listEnrollments);
router.post("/enrollments", authenticate, enrollLead);
router.get("/enrollments/:id", authenticate, getEnrollment);
router.patch("/enrollments/:id/pause", authenticate, pauseEnrollment);
router.post("/enrollments/:id/pause", authenticate, pauseEnrollment);
router.patch("/enrollments/:id/resume", authenticate, resumeEnrollment);
router.post("/enrollments/:id/resume", authenticate, resumeEnrollment);
router.patch("/enrollments/:id/stop", authenticate, stopEnrollment);
router.post("/enrollments/:id/stop", authenticate, stopEnrollment);
router.patch("/enrollments/:id/cancel", authenticate, cancelEnrollment);
router.post("/enrollments/:id/cancel", authenticate, cancelEnrollment);
router.patch("/enrollments/:id/mark-processed", authenticate, markReplyProcessed);
router.post("/enrollments/:id/mark-processed", authenticate, markReplyProcessed);

router.get("/replies", authenticate, listReplies);
router.get("/blocked-tasks", authenticate, listBlockedTasks);

router.get("/leads/:leadId", authenticate, getLeadJourney);

router.get("/tasks/:id/preview", authenticate, previewTaskContent);
router.patch("/tasks/:id", authenticate, updateTask);
router.post("/tasks/:id/retry", authenticate, retryTask);

export default router;

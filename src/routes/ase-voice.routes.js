import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import {
    handlePlivoAnswer,
    handlePlivoStatus,
    dispatchVoiceCall,
    getVoiceConfig,
    simulateVoiceOutcome,
    getCallHistory,
    makeDirectCall,
    triggerAutonomousCall,
    queueAutonomousCall,
    runSchedulerCycle,
} from "../controllers/Lead/ase-voice.controller.js";

const router = Router();

router.all("/plivo/answer", handlePlivoAnswer);
router.all("/plivo/status", handlePlivoStatus);

router.get("/history", authenticate, getCallHistory);
router.get("/config", authenticate, getVoiceConfig);
router.post("/dispatch", authenticate, dispatchVoiceCall);
router.post("/call-lead", authenticate, makeDirectCall);
router.post("/call-number", authenticate, makeDirectCall);
router.post("/autonomous-call", authenticate, triggerAutonomousCall);
router.post("/queue-call", authenticate, queueAutonomousCall);
router.post("/run-cycle", authenticate, runSchedulerCycle);
router.post("/simulate-outcome", authenticate, simulateVoiceOutcome);

export default router;

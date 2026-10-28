import { Router } from "express";
import { authenticate, requireAseAdmin, requireAseRole } from "../middleware/auth.middleware.js";
import { plivoWebhookAuth, agentflowWebhookAuth } from "../middleware/plivoAuth.middleware.js";
import {
    handlePlivoAnswer,
    handlePlivoStatus,
    handleAgentflowOutcome,
    dispatchVoiceCall,
    getVoiceConfig,
    simulateVoiceOutcome,
    getCallHistory,
    getCallDetails,
    makeDirectCall,
    triggerAutonomousCall,
    queueAutonomousCall,
    runSchedulerCycle,
} from "../controllers/Lead/ase-voice.controller.js";
import {
    handleTransferBridge,
    handleTransferJoin,
    handleTransferPromise,
    handleTransferStatus,
} from "../controllers/Ase/transfer.controller.js";

const router = Router();

router.all("/plivo/answer", plivoWebhookAuth, handlePlivoAnswer);
router.all("/plivo/status", plivoWebhookAuth, handlePlivoStatus);
router.all("/plivo/agentflow", agentflowWebhookAuth, handleAgentflowOutcome);
router.all("/plivo/transfer/bridge", plivoWebhookAuth, handleTransferBridge);
router.all("/plivo/transfer/join", plivoWebhookAuth, handleTransferJoin);
router.all("/plivo/transfer/promise", plivoWebhookAuth, handleTransferPromise);
router.all("/plivo/transfer/status", plivoWebhookAuth, handleTransferStatus);

router.get("/history", authenticate, requireAseRole, getCallHistory);
router.get("/call/:id", authenticate, requireAseRole, getCallDetails);
router.get("/config", authenticate, requireAseRole, getVoiceConfig);
router.post("/dispatch", authenticate, requireAseRole, dispatchVoiceCall);
router.post("/call-lead", authenticate, requireAseRole, makeDirectCall);
router.post("/call-number", authenticate, requireAseRole, makeDirectCall);
router.post("/autonomous-call", authenticate, requireAseAdmin, triggerAutonomousCall);
router.post("/queue-call", authenticate, requireAseAdmin, queueAutonomousCall);
router.post("/run-cycle", authenticate, requireAseAdmin, runSchedulerCycle);
router.post("/simulate-outcome", authenticate, requireAseAdmin, simulateVoiceOutcome);

export default router;

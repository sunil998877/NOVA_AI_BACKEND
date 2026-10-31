import { Router } from "express";
import { authenticate, requireAseAdmin } from "../middleware/auth.middleware.js";
import {
    listSenderAccounts,
    createSenderAccount,
    getSenderAccount,
    updateSenderAccount,
    deleteSenderAccount,
    verifySenderAccount,
    pauseSenderAccount,
    resumeSenderAccount,
} from "../controllers/SenderAccount/senderAccount.controller.js";

const router = Router();
router.use(authenticate, requireAseAdmin);

router.get("/", listSenderAccounts);
router.post("/", createSenderAccount);
router.get("/:id", getSenderAccount);
router.patch("/:id", updateSenderAccount);
router.put("/:id", updateSenderAccount);
router.delete("/:id", deleteSenderAccount);
router.post("/:id/verify", verifySenderAccount);
router.post("/:id/pause", pauseSenderAccount);
router.patch("/:id/pause", pauseSenderAccount);
router.post("/:id/resume", resumeSenderAccount);
router.patch("/:id/resume", resumeSenderAccount);

export default router;

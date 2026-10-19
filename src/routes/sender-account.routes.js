import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
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

router.get("/", authenticate, listSenderAccounts);
router.post("/", authenticate, createSenderAccount);
router.get("/:id", authenticate, getSenderAccount);
router.patch("/:id", authenticate, updateSenderAccount);
router.put("/:id", authenticate, updateSenderAccount);
router.delete("/:id", authenticate, deleteSenderAccount);
router.post("/:id/verify", authenticate, verifySenderAccount);
router.post("/:id/pause", authenticate, pauseSenderAccount);
router.patch("/:id/pause", authenticate, pauseSenderAccount);
router.post("/:id/resume", authenticate, resumeSenderAccount);
router.patch("/:id/resume", authenticate, resumeSenderAccount);

export default router;

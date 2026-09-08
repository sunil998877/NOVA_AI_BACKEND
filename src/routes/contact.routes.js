import { Router } from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import { listContacts } from "../controllers/Contact/list.controller.js";
import { createContact } from "../controllers/Contact/create.controller.js";

const router = Router();

router.get("/", authenticate, listContacts);
router.post("/", authenticate, createContact);

export default router;

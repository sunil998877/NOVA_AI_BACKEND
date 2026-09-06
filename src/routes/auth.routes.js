import { Router } from "express";
import rateLimit from "express-rate-limit";
import { signup } from "../controllers/Auth/register.controller.js";
import { signin } from "../controllers/Auth/login.controller.js";
import { googleAuth } from "../controllers/Auth/google.controller.js";
import { resetPassword } from "../controllers/Auth/reset-password.controller.js";
import { completeReset } from "../controllers/Auth/complete-reset.controller.js";
import { updateUser } from "../controllers/Auth/update-user.controller.js";
import { signout } from "../controllers/Auth/signout.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";
import { env } from "../config/env.js";

const router = Router();

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication attempts. Try again later." },
});

router.get("/config", (_req, res) => {
    res.status(200).json({
        googleClientId: env.googleClientId || "",
        googleConfigured: Boolean(env.googleClientId),
        recaptchaSiteKey: env.recaptchaSiteKey || "",
    });
});
router.post("/signup", authLimiter, signup);
router.post("/signin", authLimiter, signin);
router.post("/google", googleAuth);
router.post("/reset-password", resetPassword);
router.post("/complete-reset", completeReset);
router.post("/update-user", authenticate, updateUser);
router.post("/signout", authenticate, signout);

export default router;

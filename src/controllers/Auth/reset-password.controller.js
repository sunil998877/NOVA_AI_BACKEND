import crypto from "node:crypto";
import { User } from "../../models/user.model.js";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const resetPassword = asyncHandler(async (req, res) => {
    const { email, redirectTo } = req.body;

    if (!email) {
        return res.status(400).json({ error: "Email is required" });
    }

    const user = await User.findByEmail(email);
    const generic = {
        message: "If that email is registered, a reset link has been prepared.",
    };

    if (!user) {
        return res.status(200).json(generic);
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    await User.updateById(user.id, {
        passwordResetTokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
    });

    const base = redirectTo || "https://novaaisoft.netlify.app/reset-password";
    const resetUrl = `${base}${base.includes("?") ? "&" : "?"}token=${rawToken}&email=${encodeURIComponent(user.email)}`;

    if (env.nodeEnv !== "production") {
        return res.status(200).json({ ...generic, resetUrl });
    }

    return res.status(200).json(generic);
});

import crypto from "node:crypto";
import { User } from "../../models/user.model.js";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { sendPasswordResetEmail } from "../../utils/mailer.js";

export const resetPassword = asyncHandler(async (req, res) => {
    const { email, redirectTo } = req.body;

    if (!email) {
        return res.status(400).json({ error: "Email is required" });
    }

    const user = await User.findByEmail(email);
    const generic = {
        message: "If that email is registered, a reset link has been sent.",
    };

    if (!user) {
        return res.status(200).json(generic);
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    await User.updateById(user.id, {
        passwordResetTokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
        passwordResetExpires: new Date(Date.now() + 60 * 60 * 1000),
    });

    const base = redirectTo || `${env.frontendUrl}/update-password`;
    const resetUrl = `${base}${base.includes("?") ? "&" : "?"}token=${rawToken}&email=${encodeURIComponent(user.email)}`;

    try {
        await sendPasswordResetEmail({ to: user.email, resetUrl });
    } catch {
        return res.status(500).json({ error: "Could not send reset email. Please try again later." });
    }

    return res.status(200).json(generic);
});

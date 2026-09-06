import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { User } from "../../models/user.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

const hashesMatch = (stored, incoming) => {
    if (!stored || !incoming) return false;
    const a = Buffer.from(String(stored));
    const b = Buffer.from(String(incoming));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};

export const completeReset = asyncHandler(async (req, res) => {
    const { email, token, password, confirmPassword } = req.body;

    if (!email || !token || !password || !confirmPassword) {
        return res.status(400).json({ error: "Email, token, and passwords are required" });
    }

    if (password !== confirmPassword) {
        return res.status(400).json({ error: "Passwords do not match" });
    }

    if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const user = await User.findByEmail(email);
    if (!user) {
        return res.status(400).json({ error: "Reset link is invalid or expired" });
    }

    const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const expires = user.passwordResetExpires ? new Date(user.passwordResetExpires) : null;
    const expired = !expires || Number.isNaN(expires.getTime()) || expires.getTime() < Date.now();

    if (expired || !hashesMatch(user.passwordResetTokenHash, tokenHash)) {
        return res.status(400).json({ error: "Reset link is invalid or expired" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await User.updateById(user.id, {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetExpires: null,
        authProvider: "local",
    });

    return res.status(200).json({ success: true, message: "Password updated. You can sign in now." });
});

import bcrypt from "bcrypt";
import { User } from "../../models/user.model.js";
import { verifyCaptcha } from "../../utils/captcha.js";
import { signAuthToken } from "../../utils/jwt.js";
import { toPublicUser } from "../../utils/user.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const signup = asyncHandler(async (req, res) => {
    const {
        fullName,
        organization,
        email,
        password,
        confirmPassword,
        captchaToken,
    } = req.body;

    const captcha = await verifyCaptcha(captchaToken);
    if (!captcha.ok) {
        return res.status(400).json({ error: captcha.error });
    }

    if (!fullName || !organization || !email || !password || !confirmPassword) {
        return res.status(400).json({ error: "All signup fields are required" });
    }

    if (password !== confirmPassword) {
        return res.status(400).json({ error: "Passwords do not match" });
    }

    if (password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const existing = await User.findByEmail(email);
    if (existing) {
        return res.status(409).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
        fullName,
        organization,
        email,
        passwordHash,
        authProvider: "local",
    });

    const token = signAuthToken(user);
    return res.status(201).json({
        token,
        user: toPublicUser(user),
    });
});

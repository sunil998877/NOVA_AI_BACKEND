import bcrypt from "bcrypt";
import { User } from "../../models/user.model.js";
import { Lead } from "../../models/lead.model.js";
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

    // Auto-capture new signup as a Lead in Lead Store / ASE Pipeline
    try {
        const orgId = Number(user.organization_id || 1);
        const nameParts = (fullName || "").trim().split(/\s+/);
        const firstName = nameParts[0] || fullName;
        const lastName = nameParts.slice(1).join(" ") || "";
        await Lead.create({
            organization_id: orgId,
            user_id: user.id,
            name: fullName,
            first_name: firstName,
            last_name: lastName,
            email: email,
            company: organization || "Direct Signup",
            source: "SIGNUP",
            priority: 75,
            status: "NEW",
            metadata: { registered_as_user: true, user_id: user.id, signup_time: new Date().toISOString() },
        });
    } catch (leadErr) {
        console.warn("[Signup] Could not auto-create lead for new signup:", leadErr.message);
    }

    const token = signAuthToken(user);
    return res.status(201).json({
        token,
        user: toPublicUser(user),
    });
});

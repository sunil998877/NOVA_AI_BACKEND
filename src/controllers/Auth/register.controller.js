import bcrypt from "bcrypt";
import { User } from "../../models/user.model.js";
import { Lead } from "../../models/lead.model.js";
import { verifyCaptcha } from "../../utils/captcha.js";
import { signAuthToken } from "../../utils/jwt.js";
import { toPublicUser } from "../../utils/user.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { bindSignupAccount } from "../../services/ase/orgBinding.service.js";

export const signup = asyncHandler(async (req, res) => {
    const {
        fullName,
        organization,
        email,
        password,
        confirmPassword,
        captchaToken,
        inviteToken,
    } = req.body;

    const captcha = await verifyCaptcha(captchaToken);
    if (!captcha.ok) {
        return res.status(400).json({ error: captcha.error });
    }

    const hasInvite = Boolean(String(inviteToken || "").trim());
    if (!fullName || !email || !password || !confirmPassword || (!hasInvite && !organization)) {
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
    let bound;
    try {
        bound = await bindSignupAccount({
            fullName,
            organization,
            email,
            passwordHash,
            authProvider: "local",
            inviteToken,
        });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message || "Could not create account" });
    }

    const user = bound.user;

    try {
        const orgId = Number(user.organization_id);
        const nameParts = (fullName || "").trim().split(/\s+/);
        const firstName = nameParts[0] || fullName;
        const lastName = nameParts.slice(1).join(" ") || "";
        await Lead.create({
            organization_id: orgId,
            user_id: user.id,
            name: fullName,
            first_name: firstName,
            last_name: lastName,
            email,
            company: user.organization || organization || "Direct Signup",
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

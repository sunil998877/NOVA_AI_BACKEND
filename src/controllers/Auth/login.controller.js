import bcrypt from "bcrypt";
import { User } from "../../models/user.model.js";
import { verifyCaptcha } from "../../utils/captcha.js";
import { signAuthToken } from "../../utils/jwt.js";
import { toPublicUser } from "../../utils/user.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const signin = asyncHandler(async (req, res) => {
    const { email, password, captchaToken } = req.body;

    const captcha = await verifyCaptcha(captchaToken);
    if (!captcha.ok) {
        return res.status(400).json({ error: captcha.error });
    }

    if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await User.findByEmail(email);

    if (!user || !user.passwordHash) {
        return res.status(401).json({ error: "Invalid email or password" });
    }

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
        return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signAuthToken(user);
    return res.status(200).json({
        token,
        user: toPublicUser(user),
    });
});

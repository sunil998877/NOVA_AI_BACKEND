import { OAuth2Client } from "google-auth-library";
import { env } from "../../config/env.js";
import { User } from "../../models/user.model.js";
import { signAuthToken } from "../../utils/jwt.js";
import { toPublicUser } from "../../utils/user.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

const googleClient = new OAuth2Client();

export const googleAuth = asyncHandler(async (req, res) => {
    const { idToken } = req.body;

    if (!idToken) {
        return res.status(400).json({ error: "idToken is required" });
    }

    if (!env.googleClientIds.length) {
        return res.status(500).json({ error: "GOOGLE_CLIENT_ID is not configured" });
    }

    let payload;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience: env.googleClientIds,
        });
        payload = ticket.getPayload();
    } catch {
        return res.status(401).json({ error: "Invalid Google token" });
    }

    if (!payload?.email) {
        return res.status(401).json({ error: "Invalid Google token" });
    }

    const email = payload.email.toLowerCase();
    const googleId = payload.sub;
    const fullName = payload.name || payload.given_name || email.split("@")[0];
    const organization = payload.hd || "Independent";

    let user = await User.findByGoogleIdOrEmail(googleId, email);

    if (!user) {
        user = await User.create({
            fullName,
            organization,
            email,
            googleId,
            authProvider: "google",
        });
    } else if (!user.googleId) {
        user = await User.updateById(user.id, { googleId });
    }

    const token = signAuthToken(user);
    return res.status(200).json({
        token,
        user: toPublicUser(user),
    });
});

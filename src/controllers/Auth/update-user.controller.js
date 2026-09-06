import bcrypt from "bcrypt";
import { User } from "../../models/user.model.js";
import { toPublicUser } from "../../utils/user.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const updateUser = asyncHandler(async (req, res) => {
    const attributes = req.body.attributes || req.body;
    const { fullName, name, organization, password } = attributes;

    const user = await User.findById(req.user.id);
    if (!user) {
        return res.status(404).json({ error: "User not found" });
    }

    const fields = {};
    if (fullName || name) {
        fields.fullName = fullName || name;
    }
    if (organization) {
        fields.organization = organization;
    }
    if (password) {
        if (password.length < 8) {
            return res.status(400).json({ error: "Password must be at least 8 characters" });
        }
        fields.passwordHash = await bcrypt.hash(password, 10);
        if (user.authProvider === "google") {
            fields.authProvider = "local";
        }
    }

    const updated = await User.updateById(user.id, fields);
    return res.status(200).json({ user: toPublicUser(updated) });
});

import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export const signAuthToken = (user) => {
    if (!env.jwtSecret) {
        throw new Error("JWT_SECRET is not configured");
    }

    return jwt.sign(
        {
            sub: String(user._id ?? user.id),
            email: user.email,
        },
        env.jwtSecret,
        { expiresIn: env.jwtExpiresIn }
    );
};

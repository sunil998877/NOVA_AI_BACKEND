import { asyncHandler } from "../../utils/asyncHandler.js";

export const signout = asyncHandler(async (_req, res) => {
    return res.status(200).json({
        success: true,
        message: "Signed out. Discard the JWT on the client.",
    });
});

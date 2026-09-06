import { asyncHandler } from "../../utils/asyncHandler.js";

export const sheetsNotConfigured = asyncHandler(async (_req, res) => {
    return res.status(501).json({
        error: "Google Sheets is not configured on this backend yet.",
    });
});

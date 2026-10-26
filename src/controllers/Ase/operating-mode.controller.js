import { asyncHandler } from "../../utils/asyncHandler.js";
import { getOperatingMode, setOperatingMode } from "../../services/ase/operatingMode.service.js";

export const getOperatingModeStatus = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const mode = await getOperatingMode(orgId);
    return res.status(200).json({
        success: true,
        mode,
        organizationId: orgId,
    });
});

export const updateOperatingMode = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const { mode } = req.body || {};
    if (!mode) {
        return res.status(400).json({ error: "Mode parameter is required" });
    }
    try {
        const result = await setOperatingMode(orgId, mode);
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

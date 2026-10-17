import { asyncHandler } from "../../utils/asyncHandler.js";
import { Suppression } from "../../models/suppression.model.js";

export const listSuppressions = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const { page, limit } = req.query;
    const p = Math.max(Number(page) || 1, 1);
    const l = Math.min(Math.max(Number(limit) || 100, 1), 500);

    const items = await Suppression.list(orgId, { limit: l, skip: (p - 1) * l });
    return res.status(200).json({ data: items });
});

export const addSuppression = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const { type, value, reason } = req.body;
    if (!type || !value) {
        return res.status(400).json({ error: "Type (EMAIL, PHONE, DOMAIN) and value are required" });
    }

    await Suppression.add(orgId, type, value, reason || "Manual suppression entry");
    return res.status(201).json({ data: { success: true } });
});

export const removeSuppression = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const ok = await Suppression.remove(orgId, req.params.id);
    if (!ok) return res.status(404).json({ error: "Suppression entry not found" });
    return res.status(200).json({ data: { deleted: true } });
});

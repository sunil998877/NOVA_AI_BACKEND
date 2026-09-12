import { Collaboration } from "../../models/collaboration.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const listCollaborations = asyncHandler(async (req, res) => {
    const { q = "", platform = "", status = "", page = 1, limit = 50 } = req.query;
    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;

    const [data, total] = await Promise.all([
        Collaboration.listByUser(req.user.id, {
            q: String(q || ""),
            platform: String(platform || ""),
            status: String(status || ""),
            skip,
            limit: safeLimit,
        }),
        Collaboration.countByUser(req.user.id, {
            q: String(q || ""),
            platform: String(platform || ""),
            status: String(status || ""),
        }),
    ]);

    return res.status(200).json({
        data,
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit) || 1,
    });
});

export const getCollaboration = asyncHandler(async (req, res) => {
    const item = await Collaboration.findById(req.params.id, req.user.id);
    if (!item) {
        return res.status(404).json({ error: "Collaboration record not found" });
    }
    return res.status(200).json(item);
});

export const updateCollaboration = asyncHandler(async (req, res) => {
    const { status } = req.body;
    if (!status) {
        return res.status(400).json({ error: "Status is required" });
    }
    const updated = await Collaboration.updateStatus(req.params.id, req.user.id, String(status).trim());
    if (!updated) {
        return res.status(404).json({ error: "Collaboration record not found" });
    }
    return res.status(200).json(updated);
});

export const deleteCollaboration = asyncHandler(async (req, res) => {
    const success = await Collaboration.delete(req.params.id, req.user.id);
    if (!success) {
        return res.status(404).json({ error: "Collaboration record not found" });
    }
    return res.status(200).json({ success: true, message: "Collaboration record deleted" });
});

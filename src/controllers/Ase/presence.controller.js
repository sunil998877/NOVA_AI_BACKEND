import { asyncHandler } from "../../utils/asyncHandler.js";
import { User } from "../../models/user.model.js";
import { getIo } from "../../socket/socketServer.js";
import { asePresenceStore } from "../../socket/asePresence.store.js";
import { emitAsePresence } from "../../socket/asePresenceHandlers.js";
import { presenceSummary } from "../../services/ase/asePresence.service.js";
import { ASE_PRESENCE_STATES } from "../../services/ase/asePresence.constants.js";

function mergeRoster(reps, live) {
    const byId = new Map((live || []).map((row) => [String(row.userId), row]));
    return (reps || []).map((rep) => {
        const id = String(rep.id);
        const found = byId.get(id);
        if (found) {
            return {
                ...found,
                name: found.name || rep.fullName || "",
                role: found.role || rep.role || "",
            };
        }
        return {
            userId: id,
            organizationId: Number(rep.organization_id || 0),
            name: rep.fullName || "",
            role: rep.role || "",
            state: ASE_PRESENCE_STATES.OFFLINE,
            freeWithinSeconds: 0,
            socketCount: 0,
            updatedAt: null,
            lastHeartbeatAt: null,
        };
    });
}

export const getAsePresence = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id);
    const reps = await User.listRoutableReps(orgId).catch(() => []);
    const live = asePresenceStore.listByOrg(orgId);
    const merged = mergeRoster(reps, live);
    const data = presenceSummary(merged);
    data.self = live.find((row) => String(row.userId) === String(req.user.id)) || null;
    return res.status(200).json({ data });
});

export const setAsePresence = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id);
    const userId = String(req.user.id);
    const current = asePresenceStore.get(userId);
    if (!current || Number(current.socketCount || 0) < 1) {
        return res.status(409).json({ error: "ASE presence socket is not connected" });
    }
    const updated = asePresenceStore.setState(userId, {
        state: req.body?.state,
        freeWithinSeconds: req.body?.freeWithinSeconds,
        name: req.user.fullName || req.user.name || "",
        role: req.user.role,
    });
    const io = getIo();
    if (io) emitAsePresence(io, orgId);
    return res.status(200).json({ data: updated });
});

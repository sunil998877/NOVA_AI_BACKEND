import { ASE_ORG_ROOM, ASE_PRESENCE_STATES } from "../services/ase/asePresence.constants.js";
import { presenceSummary } from "../services/ase/asePresence.service.js";
import { canUseAse } from "../services/ase/roles.constants.js";
import { asePresenceStore } from "./asePresence.store.js";

function broadcastOrg(io, orgId) {
    const id = Number(orgId || 0);
    if (!id) return;
    const reps = asePresenceStore.listByOrg(id);
    io.to(ASE_ORG_ROOM(id)).emit("ase:presence:state", presenceSummary(reps));
}

export function registerAsePresenceHandlers(io, socket) {
    const user = socket.user;
    if (!user || user.role === "influencer") return;
    if (!canUseAse(user.aseRole || user.role)) return;

    const orgId = Number(user.organization_id || 0);
    const userId = String(user.userId || user.id || "");
    if (!orgId || !userId) return;

    socket.join(ASE_ORG_ROOM(orgId));
    asePresenceStore.join({
        userId,
        organizationId: orgId,
        socketId: socket.id,
        name: user.name || user.fullName || "",
        role: user.aseRole || user.role,
        state: ASE_PRESENCE_STATES.AVAILABLE,
    });
    socket.emit("ase:presence:state", presenceSummary(asePresenceStore.listByOrg(orgId)));
    broadcastOrg(io, orgId);

    socket.on("ase:presence:set", (payload = {}, callback) => {
        const updated = asePresenceStore.setState(userId, {
            state: payload.state,
            freeWithinSeconds: payload.freeWithinSeconds,
            name: user.name,
            role: user.aseRole || user.role,
        });
        broadcastOrg(io, orgId);
        if (typeof callback === "function") callback(updated);
    });

    socket.on("ase:presence:heartbeat", () => {
        asePresenceStore.heartbeat(userId);
    });

    socket.on("disconnect", () => {
        asePresenceStore.leave(socket.id);
        broadcastOrg(io, orgId);
    });
}

export function emitAsePresence(io, orgId) {
    broadcastOrg(io, orgId);
}

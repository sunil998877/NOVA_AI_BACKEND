import { eventBus } from "../ase/eventBus.service.js";
import { getIo } from "../../socket/socketServer.js";

export function emitOrgEvent(organizationId, eventName, payload = {}) {
    const orgId = Number(organizationId || 1);
    const body = {
        organizationId: orgId,
        ...payload,
        emittedAt: new Date().toISOString(),
    };
    try {
        const io = getIo();
        if (io) {
            io.to(`org:${orgId}`).emit(eventName, body);
        }
    } catch (_) {}
    return body;
}

export async function publishAseEvent(eventType, options = {}) {
    return eventBus.publish(eventType, options);
}

import { ASE_PRESENCE_STATES } from "../services/ase/asePresence.constants.js";
import { clampFreeWithinSeconds, normalizePresenceState } from "../services/ase/asePresence.service.js";

class AsePresenceStore {
    constructor() {
        this.byUser = new Map();
        this.socketUser = new Map();
    }

    reset() {
        this.byUser.clear();
        this.socketUser.clear();
    }

    join({ userId, organizationId, socketId, name = "", role = "", state = ASE_PRESENCE_STATES.AVAILABLE }) {
        const id = String(userId || "");
        if (!id || !socketId) return null;
        this.socketUser.set(socketId, id);
        const existing = this.byUser.get(id) || {
            userId: id,
            organizationId: Number(organizationId || 0),
            name,
            role,
            state: ASE_PRESENCE_STATES.OFFLINE,
            freeWithinSeconds: 0,
            socketIds: new Set(),
            updatedAt: null,
            lastHeartbeatAt: null,
        };
        existing.organizationId = Number(organizationId || existing.organizationId || 0);
        existing.name = name || existing.name;
        existing.role = role || existing.role;
        existing.socketIds.add(socketId);
        const connected = existing.socketIds.size > 0;
        if (existing.state === ASE_PRESENCE_STATES.OFFLINE) {
            existing.state = normalizePresenceState(state, { connected });
            existing.freeWithinSeconds = 0;
        }
        existing.lastHeartbeatAt = new Date().toISOString();
        existing.updatedAt = existing.lastHeartbeatAt;
        this.byUser.set(id, existing);
        return this.present(existing);
    }

    leave(socketId) {
        const userId = this.socketUser.get(socketId);
        if (!userId) return null;
        this.socketUser.delete(socketId);
        const row = this.byUser.get(userId);
        if (!row) return null;
        row.socketIds.delete(socketId);
        if (row.socketIds.size === 0) {
            row.state = ASE_PRESENCE_STATES.OFFLINE;
            row.freeWithinSeconds = 0;
            row.updatedAt = new Date().toISOString();
        }
        return this.present(row);
    }

    setState(userId, { state, freeWithinSeconds, name, role } = {}) {
        const row = this.byUser.get(String(userId || ""));
        if (!row) return null;
        const connected = row.socketIds.size > 0;
        row.state = normalizePresenceState(state || row.state, { connected });
        row.freeWithinSeconds = row.state === ASE_PRESENCE_STATES.AVAILABLE
            ? 0
            : clampFreeWithinSeconds(freeWithinSeconds);
        if (name) row.name = name;
        if (role) row.role = role;
        row.lastHeartbeatAt = new Date().toISOString();
        row.updatedAt = row.lastHeartbeatAt;
        return this.present(row);
    }

    heartbeat(userId) {
        const row = this.byUser.get(String(userId || ""));
        if (!row) return null;
        row.lastHeartbeatAt = new Date().toISOString();
        return this.present(row);
    }

    get(userId) {
        const row = this.byUser.get(String(userId || ""));
        return row ? this.present(row) : null;
    }

    listByOrg(orgId) {
        const id = Number(orgId || 0);
        return Array.from(this.byUser.values())
            .filter((row) => Number(row.organizationId) === id)
            .map((row) => this.present(row));
    }

    present(row) {
        return {
            userId: row.userId,
            organizationId: row.organizationId,
            name: row.name,
            role: row.role,
            state: row.state,
            freeWithinSeconds: row.freeWithinSeconds,
            socketCount: row.socketIds.size,
            socketIds: Array.from(row.socketIds),
            updatedAt: row.updatedAt,
            lastHeartbeatAt: row.lastHeartbeatAt,
        };
    }
}

export const asePresenceStore = new AsePresenceStore();

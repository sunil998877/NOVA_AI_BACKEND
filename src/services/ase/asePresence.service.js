import {
    ASE_PRESENCE_HEARTBEAT_STALE_MS,
    ASE_PRESENCE_STATES,
    TRANSFER_WINDOW_SECONDS,
} from "./asePresence.constants.js";

export function normalizePresenceState(state, { connected = false } = {}) {
    if (!connected) return ASE_PRESENCE_STATES.OFFLINE;
    const value = String(state || "").toUpperCase().trim();
    if (value === ASE_PRESENCE_STATES.AVAILABLE) return ASE_PRESENCE_STATES.AVAILABLE;
    if (value === ASE_PRESENCE_STATES.ON_CALL) return ASE_PRESENCE_STATES.ON_CALL;
    if (value === ASE_PRESENCE_STATES.AWAY) return ASE_PRESENCE_STATES.AWAY;
    return ASE_PRESENCE_STATES.AVAILABLE;
}

export function clampFreeWithinSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(120, Math.round(n));
}

export function presentAseRep(row = {}, { now = Date.now(), staleMs = ASE_PRESENCE_HEARTBEAT_STALE_MS } = {}) {
    const socketCount = Number(row.socketCount || (row.socketIds || []).length || 0);
    const connected = socketCount > 0;
    const heartbeatAt = new Date(row.lastHeartbeatAt || row.updatedAt || 0).getTime();
    const stale = connected && heartbeatAt > 0 ? now - heartbeatAt > staleMs : !connected;
    const live = connected && !stale;
    const state = live
        ? normalizePresenceState(row.state || ASE_PRESENCE_STATES.AVAILABLE, { connected: true })
        : ASE_PRESENCE_STATES.OFFLINE;
    const freeWithinSeconds = state === ASE_PRESENCE_STATES.AVAILABLE
        ? 0
        : clampFreeWithinSeconds(row.freeWithinSeconds);

    return {
        userId: String(row.userId || row.id || ""),
        organizationId: Number(row.organizationId || row.organization_id || 0),
        name: row.name || row.fullName || "",
        role: row.role || "",
        state,
        freeWithinSeconds,
        socketCount,
        connected: live,
        updatedAt: row.updatedAt || null,
        lastHeartbeatAt: row.lastHeartbeatAt || null,
    };
}

export function isFreeNow(rep) {
    return String(rep?.state) === ASE_PRESENCE_STATES.AVAILABLE;
}

export function isFreeWithin(rep, windowSeconds = TRANSFER_WINDOW_SECONDS.default) {
    if (isFreeNow(rep)) return true;
    const state = String(rep?.state || "");
    if (state === ASE_PRESENCE_STATES.OFFLINE) return false;
    const seconds = Number(rep?.freeWithinSeconds || 0);
    const window = Number(windowSeconds || TRANSFER_WINDOW_SECONDS.default);
    return seconds > 0 && seconds <= window;
}

export function hasLiveAsePresence(reps = []) {
    return (reps || []).some((rep) => presentAseRep(rep).connected);
}

export function countAseFreeNow(reps = []) {
    return (reps || []).map((rep) => presentAseRep(rep)).filter(isFreeNow).length;
}

export function countAseFreeWithin(reps = [], windowSeconds = TRANSFER_WINDOW_SECONDS.default) {
    return (reps || []).map((rep) => presentAseRep(rep)).filter((rep) => isFreeWithin(rep, windowSeconds)).length;
}

export function pickFreeRep(reps = [], { windowSeconds = TRANSFER_WINDOW_SECONDS.default } = {}) {
    const presented = (reps || []).map((rep) => presentAseRep(rep));
    return presented.find((rep) => isFreeNow(rep))
        || presented.find((rep) => isFreeWithin(rep, windowSeconds))
        || null;
}

export function presenceSummary(reps = [], windowSeconds = TRANSFER_WINDOW_SECONDS.default) {
    const presented = (reps || []).map((rep) => presentAseRep(rep));
    return {
        available: presented.filter((rep) => rep.state === ASE_PRESENCE_STATES.AVAILABLE).length,
        onCall: presented.filter((rep) => rep.state === ASE_PRESENCE_STATES.ON_CALL).length,
        away: presented.filter((rep) => rep.state === ASE_PRESENCE_STATES.AWAY).length,
        offline: presented.filter((rep) => rep.state === ASE_PRESENCE_STATES.OFFLINE).length,
        freeNow: presented.filter(isFreeNow).length,
        freeWithin: presented.filter((rep) => isFreeWithin(rep, windowSeconds)).length,
        transferWindowSeconds: windowSeconds,
        reps: presented,
    };
}

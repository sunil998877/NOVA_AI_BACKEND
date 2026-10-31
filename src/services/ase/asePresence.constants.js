export const ASE_PRESENCE_STATES = Object.freeze({
    AVAILABLE: "AVAILABLE",
    ON_CALL: "ON_CALL",
    AWAY: "AWAY",
    OFFLINE: "OFFLINE",
});

export const ASE_PRESENCE_STATE_LIST = Object.freeze(Object.values(ASE_PRESENCE_STATES));

export const TRANSFER_WINDOW_SECONDS = Object.freeze({ min: 8, max: 15, default: 12 });

export const ASE_PRESENCE_HEARTBEAT_STALE_MS = 90 * 1000;
export const ASE_ORG_ROOM = (orgId) => `ase:org:${Number(orgId) || 0}`;

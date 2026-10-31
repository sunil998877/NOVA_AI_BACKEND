export const CLICK_TO_CALL_SOURCE = "CLICK_TO_CALL";

export const CLICK_TO_CALL_STATES = Object.freeze({
    IDLE: "idle",
    INITIATING: "initiating",
    CALLING_YOU: "calling_you",
    YOU_ANSWERED: "you_answered",
    CALLING_LEAD: "calling_lead",
    CONNECTED: "connected",
    COMPLETED: "completed",
    BUSY: "busy",
    NO_ANSWER: "no_answer",
    FAILED: "failed",
});

export const CLICK_TO_CALL_TERMINAL = new Set([
    CLICK_TO_CALL_STATES.COMPLETED,
    CLICK_TO_CALL_STATES.BUSY,
    CLICK_TO_CALL_STATES.NO_ANSWER,
    CLICK_TO_CALL_STATES.FAILED,
]);

export const CLICK_TO_CALL_OPEN_STATUSES = new Set([
    "initiated",
    "ringing",
    "in-progress",
    "queued",
    "unknown",
]);

export const CLICK_TO_CALL_REUSE_WINDOW_MS = 2 * 60 * 1000;
export const CLICK_TO_CALL_STALE_GRACE_SEC = 15;

export const CLICK_TO_CALL_LABELS = Object.freeze({
    idle: "Call",
    initiating: "Calling...",
    calling_you: "Calling...",
    you_answered: "Connecting...",
    calling_lead: "Calling lead",
    connected: "Connected",
    completed: "Call",
    busy: "Call",
    no_answer: "Call",
    failed: "Call",
});

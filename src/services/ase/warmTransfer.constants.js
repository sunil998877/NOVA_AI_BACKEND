export const WARM_TRANSFER_ACTIONS = Object.freeze({
    TRANSFER: "TRANSFER",
    CALLBACK: "CALLBACK",
});

export const WARM_TRANSFER_REASONS = Object.freeze({
    CALL_NOT_LIVE: "CALL_NOT_LIVE",
    NO_CALL_UUID: "NO_CALL_UUID",
    NO_FREE_REP: "NO_FREE_REP",
    REP_OUTSIDE_WINDOW: "REP_OUTSIDE_WINDOW",
    REP_NO_TRANSFER_NUMBER: "REP_NO_TRANSFER_NUMBER",
    ALREADY_HANDED_OFF: "ALREADY_HANDED_OFF",
    TRANSFER_FAILED: "TRANSFER_FAILED",
    PROVIDER_FAILED: "PROVIDER_FAILED",
});

export const LIVE_CALL_STATUSES = Object.freeze([
    "in-progress",
    "in_progress",
    "inprogress",
    "answered",
    "ringing",
    "early-media",
    "early_media",
]);

export const FINISHED_CALL_STATUSES = Object.freeze([
    "completed",
    "busy",
    "no-answer",
    "no_answer",
    "timeout",
    "failed",
    "canceled",
    "cancelled",
    "rejected",
    "hangup",
]);

export const FINISHED_CALL_EVENTS = Object.freeze([
    "completed",
    "hangup",
    "end",
    "ended",
    "call_ended",
    "finished",
]);

export const HOLD_CONNECT_SPEECH =
    "Please hold. I am connecting you to a specialist who can help right now.";

export const CALLBACK_PROMISE_SPEECH =
    "Thanks. A specialist will call you back within thirty minutes. Goodbye.";

export const REP_CONNECT_SPEECH =
    "Connecting you to an interested prospect. They are already on the line.";

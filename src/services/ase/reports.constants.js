export const FIRST_TOUCH_EVENTS = Object.freeze([
    "EMAIL_SENT",
    "CALL_INITIATED",
    "CallDispatched",
    "OUTBOUND_CALL",
]);

export const FIRST_TOUCH_COMPLETED = Object.freeze(["ActionCompleted", "ActionDispatched"]);
export const FIRST_TOUCH_CHANNELS = Object.freeze(["EMAIL", "VOICE"]);

export const INTEREST_STATUSES = Object.freeze([
    "INTERESTED",
    "CALLBACK_SCHEDULED",
    "HANDED_OFF",
    "WARM_TRANSFER",
]);

export const MEETING_STATUSES = Object.freeze(["CLOSED_WON", "MEETING_BOOKED"]);

export const COMPLIANCE_EVENT_TYPES = Object.freeze([
    "ACTION_BLOCKED_BY_COMPLIANCE",
    "LEAD_SUPPRESSED",
    "OUTREACH_HALTED",
    "LIFECYCLE_CLOSED",
    "LIFECYCLE_NO_RESPONSE",
    "CAPACITY_DEFERRED",
    "SUPPRESSION_APPLIED",
]);

export const COMPLIANCE_KINDS = Object.freeze({
    CONSENT: "CONSENT",
    DNC: "DNC",
    CAP: "CAP",
    BLOCK: "BLOCK",
});

export const CADENCE_ACTIONS = Object.freeze({
    CALL: "CALL",
    EMAIL: "EMAIL",
    HUMAN_REVIEW: "HUMAN_REVIEW",
    CLOSE: "CLOSE",
});

export const STEP_STATUS = Object.freeze({
    SCHEDULED: "SCHEDULED",
    PENDING_APPROVAL: "PENDING_APPROVAL",
    EXECUTING: "EXECUTING",
    AWAITING_OUTCOME: "AWAITING_OUTCOME",
    DONE: "DONE",
    SKIPPED: "SKIPPED",
    CANCELLED: "CANCELLED",
    FAILED: "FAILED",
});

export const OPEN_STEP_STATUSES = Object.freeze([
    STEP_STATUS.SCHEDULED,
    STEP_STATUS.PENDING_APPROVAL,
    STEP_STATUS.EXECUTING,
    STEP_STATUS.AWAITING_OUTCOME,
]);

export const ENROLLMENT_STATUS = Object.freeze({
    ACTIVE: "ACTIVE",
    PAUSED: "PAUSED",
    NEEDS_REVIEW: "NEEDS_REVIEW",
    HANDOFF: "HANDOFF",
    CALLBACK: "CALLBACK",
    REPLIED: "REPLIED",
    STOPPED: "STOPPED",
    COMPLETED: "COMPLETED",
});

export const OPEN_ENROLLMENT_STATUSES = Object.freeze([
    ENROLLMENT_STATUS.ACTIVE,
    ENROLLMENT_STATUS.PAUSED,
    ENROLLMENT_STATUS.NEEDS_REVIEW,
    ENROLLMENT_STATUS.HANDOFF,
    ENROLLMENT_STATUS.CALLBACK,
    ENROLLMENT_STATUS.REPLIED,
]);

export const RESUMABLE_ENROLLMENT_STATUSES = Object.freeze([
    ENROLLMENT_STATUS.PAUSED,
    ENROLLMENT_STATUS.NEEDS_REVIEW,
    ENROLLMENT_STATUS.HANDOFF,
    ENROLLMENT_STATUS.CALLBACK,
    ENROLLMENT_STATUS.REPLIED,
]);

export const CLOSED_ENROLLMENT_STATUSES = Object.freeze([
    ENROLLMENT_STATUS.STOPPED,
    ENROLLMENT_STATUS.COMPLETED,
]);

export const ELIGIBILITY = Object.freeze({
    ELIGIBLE: "ELIGIBLE",
    NEEDS_REVIEW: "NEEDS_REVIEW",
    SUPPRESSED: "SUPPRESSED",
});

export const CALL_RESULT = Object.freeze({
    NO_ANSWER: "NO_ANSWER",
    BUSY: "BUSY",
    VOICEMAIL: "VOICEMAIL",
    INTERESTED: "INTERESTED",
    MEETING_REQUESTED: "MEETING_REQUESTED",
    CALLBACK_REQUESTED: "CALLBACK_REQUESTED",
    NEEDS_INFORMATION: "NEEDS_INFORMATION",
    FOLLOW_UP_REQUIRED: "FOLLOW_UP_REQUIRED",
    NOT_INTERESTED: "NOT_INTERESTED",
    OPT_OUT: "OPT_OUT",
    INVALID_NUMBER: "INVALID_NUMBER",
    FAILED: "FAILED",
});

export const ANSWERED_RESULTS = Object.freeze(new Set([
    CALL_RESULT.INTERESTED,
    CALL_RESULT.MEETING_REQUESTED,
    CALL_RESULT.CALLBACK_REQUESTED,
    CALL_RESULT.NEEDS_INFORMATION,
    CALL_RESULT.FOLLOW_UP_REQUIRED,
    CALL_RESULT.NOT_INTERESTED,
    CALL_RESULT.OPT_OUT,
]));

export const CALL_STATE = Object.freeze({
    QUEUED: "QUEUED",
    CALLING: "CALLING",
    RINGING: "RINGING",
    IN_PROGRESS: "IN_PROGRESS",
    COMPLETED: "COMPLETED",
    NO_ANSWER: "NO_ANSWER",
    BUSY: "BUSY",
    VOICEMAIL: "VOICEMAIL",
    FAILED: "FAILED",
    CANCELLED: "CANCELLED",
});

export const EMAIL_STATE = Object.freeze({
    DRAFT: "DRAFT",
    PENDING_APPROVAL: "PENDING_APPROVAL",
    SCHEDULED: "SCHEDULED",
    SENDING: "SENDING",
    SENT: "SENT",
    DELIVERED: "DELIVERED",
    BOUNCED: "BOUNCED",
    FAILED: "FAILED",
    REPLIED: "REPLIED",
    UNSUBSCRIBED: "UNSUBSCRIBED",
});

export const STEP_PURPOSE = Object.freeze({
    FIRST_CALL: "FIRST_CALL",
    RETRY_CALL: "RETRY_CALL",
    FOLLOW_UP_CALL: "FOLLOW_UP_CALL",
    MISSED_CALL_EMAIL: "MISSED_CALL",
    VALUE_EMAIL: "VALUE",
    INSIGHT_EMAIL: "INSIGHT",
    REVIEW: "REVIEW",
    CLOSE: "CLOSE",
});

export const DECIDED_BY = Object.freeze({
    POLICY: "POLICY",
    RULE: "RULE",
    USER: "USER",
    ML: "ML",
});

export const VOICEMAIL_ACTIONS = Object.freeze(["EMAIL", "RETRY", "HUMAN_REVIEW"]);
export const APPROVAL_MODES = Object.freeze(["MANUAL", "AUTO"]);
export const CLOSE_OUTCOMES = Object.freeze(["NURTURE", "CLOSED_LOST"]);

export const DEFAULT_CADENCE_SETTINGS = Object.freeze({
    firstAction: CADENCE_ACTIONS.CALL,
    maxInitialCallAttempts: 2,
    retryEnabled: true,
    retryIntervalMinutes: 120,
    busyRetryEnabled: true,
    busyRetryIntervalMinutes: 240,
    voicemailAction: "EMAIL",
    emailAfterRetryDelayMinutes: 30,
    emailApprovalMode: "MANUAL",
    allowEmailAfterFailedCall: false,
    maxTotalCalls: 4,
    maxTotalEmails: 4,
    timezone: null,
    callingWindow: Object.freeze({ startHour: 9, endHour: 20, days: Object.freeze([1, 2, 3, 4, 5]) }),
    emailWindow: Object.freeze({ startHour: 9, endHour: 18, days: Object.freeze([1, 2, 3, 4, 5]) }),
    followUpSteps: Object.freeze([
        Object.freeze({ key: "day3_email", day: 3, action: CADENCE_ACTIONS.EMAIL, purpose: STEP_PURPOSE.VALUE_EMAIL }),
        Object.freeze({ key: "day5_call", day: 5, action: CADENCE_ACTIONS.CALL, purpose: STEP_PURPOSE.FOLLOW_UP_CALL }),
        Object.freeze({ key: "day8_email", day: 8, action: CADENCE_ACTIONS.EMAIL, purpose: STEP_PURPOSE.INSIGHT_EMAIL }),
        Object.freeze({ key: "day12_review", day: 12, action: CADENCE_ACTIONS.HUMAN_REVIEW, purpose: STEP_PURPOSE.REVIEW }),
        Object.freeze({ key: "day17_close", day: 17, action: CADENCE_ACTIONS.CLOSE, purpose: STEP_PURPOSE.CLOSE }),
    ]),
    closeOutcome: "NURTURE",
});

export const SETTINGS_LIMITS = Object.freeze({
    maxInitialCallAttempts: [1, 5],
    retryIntervalMinutes: [15, 10080],
    busyRetryIntervalMinutes: [15, 10080],
    emailAfterRetryDelayMinutes: [0, 10080],
    maxTotalCalls: [1, 10],
    maxTotalEmails: [0, 10],
    followUpDay: [1, 60],
    followUpSteps: [0, 12],
});

export const HOT_LEAD_STATUSES = Object.freeze(new Set([
    "INTERESTED",
    "CALLBACK_SCHEDULED",
    "WARM_TRANSFER",
    "HANDED_OFF",
    "MEETING_BOOKED",
]));

export const CADENCE_NEXT_ACTION = "CADENCE";
export const STALE_EXECUTING_MS = 10 * 60 * 1000;
export const STALE_AWAITING_OUTCOME_MS = 3 * 60 * 60 * 1000;
export const ORPHAN_ENROLLMENT_MS = 5 * 60 * 1000;

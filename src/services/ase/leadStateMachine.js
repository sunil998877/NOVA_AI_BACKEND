import { createMachine, createActor } from "xstate";

export const ASE_STATES = {
    NEW: "NEW",
    QUEUED: "QUEUED",
    CONTACTED: "CONTACTED",
    ENGAGED: "ENGAGED",
    INTERESTED: "INTERESTED",
    CALLBACK_SCHEDULED: "CALLBACK_SCHEDULED",
    WARM_TRANSFER: "WARM_TRANSFER",
    HANDED_OFF: "HANDED_OFF",
    NO_RESPONSE: "NO_RESPONSE",
    NOT_INTERESTED: "NOT_INTERESTED",
    RE_ENGAGEMENT_POOL: "RE_ENGAGEMENT_POOL",
    CLOSED_WON: "CLOSED_WON",
    CLOSED_LOST: "CLOSED_LOST",
    CLOSED_UNQUALIFIED: "CLOSED_UNQUALIFIED",
    SUPPRESSED_DNC: "SUPPRESSED_DNC",
};

export const TERMINAL_STATES = [
    ASE_STATES.CLOSED_WON,
    ASE_STATES.CLOSED_LOST,
    ASE_STATES.CLOSED_UNQUALIFIED,
    ASE_STATES.SUPPRESSED_DNC,
];

export const ASE_EVENTS = {
    QUEUE: "QUEUE",
    DISPATCH_EMAIL: "DISPATCH_EMAIL",
    DISPATCH_CALL: "DISPATCH_CALL",
    EMAIL_SENT: "EMAIL_SENT",
    CALL_INITIATED: "CALL_INITIATED",
    EMAIL_ENGAGED: "EMAIL_ENGAGED",
    INTEREST_DETECTED: "INTEREST_DETECTED",
    CALLBACK_REQUESTED: "CALLBACK_REQUESTED",
    WARM_TRANSFER: "WARM_TRANSFER",
    HANDOFF_COMPLETED: "HANDOFF_COMPLETED",
    TRANSFER_FAILED: "TRANSFER_FAILED",
    NO_RESPONSE: "NO_RESPONSE",
    NOT_INTERESTED: "NOT_INTERESTED",
    RE_ENGAGE: "RE_ENGAGE",
    CLOSE_WON: "CLOSE_WON",
    CLOSE_LOST: "CLOSE_LOST",
    CLOSE_UNQUALIFIED: "CLOSE_UNQUALIFIED",
    DNC: "DNC",
    SUPPRESS_DNC: "SUPPRESS_DNC",
};

export function createLeadStateMachine(initialState = "NEW") {
    const validInitial = Object.values(ASE_STATES).includes(initialState) ? initialState : "NEW";

    return createMachine({
        id: "leadLifecycle",
        initial: validInitial,
        states: {
            NEW: {
                on: {
                    QUEUE: "QUEUED",
                    DISPATCH_EMAIL: "QUEUED",
                    DISPATCH_CALL: "QUEUED",
                    EMAIL_SENT: "CONTACTED",
                    CALL_INITIATED: "CONTACTED",
                    INTEREST_DETECTED: "INTERESTED",
                    CALLBACK_REQUESTED: "CALLBACK_SCHEDULED",
                    NOT_INTERESTED: "NOT_INTERESTED",
                    NO_RESPONSE: "NO_RESPONSE",
                    CLOSE_LOST: "CLOSED_LOST",
                    CLOSE_UNQUALIFIED: "CLOSED_UNQUALIFIED",
                    CLOSE_WON: "CLOSED_WON",
                    DNC: "SUPPRESSED_DNC",
                    SUPPRESS_DNC: "SUPPRESSED_DNC",
                },
            },
            QUEUED: {
                on: {
                    EMAIL_SENT: "CONTACTED",
                    CALL_INITIATED: "CONTACTED",
                    DISPATCH_EMAIL: "QUEUED",
                    DISPATCH_CALL: "QUEUED",
                    INTEREST_DETECTED: "INTERESTED",
                    CALLBACK_REQUESTED: "CALLBACK_SCHEDULED",
                    NOT_INTERESTED: "NOT_INTERESTED",
                    NO_RESPONSE: "NO_RESPONSE",
                    CLOSE_LOST: "CLOSED_LOST",
                    CLOSE_UNQUALIFIED: "CLOSED_UNQUALIFIED",
                    DNC: "SUPPRESSED_DNC",
                    SUPPRESS_DNC: "SUPPRESSED_DNC",
                },
            },
            CONTACTED: {
                on: {
                    EMAIL_ENGAGED: "ENGAGED",
                    CALL_ENGAGED: "ENGAGED",
                    INTEREST_DETECTED: "INTERESTED",
                    CALLBACK_REQUESTED: "CALLBACK_SCHEDULED",
                    WARM_TRANSFER: "WARM_TRANSFER",
                    NOT_INTERESTED: "NOT_INTERESTED",
                    NO_RESPONSE: "NO_RESPONSE",
                    RE_ENGAGE: "RE_ENGAGEMENT_POOL",
                    CLOSE_WON: "CLOSED_WON",
                    CLOSE_LOST: "CLOSED_LOST",
                    CLOSE_UNQUALIFIED: "CLOSED_UNQUALIFIED",
                    DNC: "SUPPRESSED_DNC",
                    SUPPRESS_DNC: "SUPPRESSED_DNC",
                },
            },
            ENGAGED: {
                on: {
                    DISPATCH_CALL: "ENGAGED",
                    CALL_INITIATED: "ENGAGED",
                    INTEREST_DETECTED: "INTERESTED",
                    CALLBACK_REQUESTED: "CALLBACK_SCHEDULED",
                    WARM_TRANSFER: "WARM_TRANSFER",
                    CLOSE_WON: "CLOSED_WON",
                    CLOSE_LOST: "CLOSED_LOST",
                    CLOSE_UNQUALIFIED: "CLOSED_UNQUALIFIED",
                    NOT_INTERESTED: "NOT_INTERESTED",
                    NO_RESPONSE: "NO_RESPONSE",
                    RE_ENGAGE: "RE_ENGAGEMENT_POOL",
                    DNC: "SUPPRESSED_DNC",
                    SUPPRESS_DNC: "SUPPRESSED_DNC",
                },
            },
            INTERESTED: {
                on: {
                    CALLBACK_REQUESTED: "CALLBACK_SCHEDULED",
                    WARM_TRANSFER: "WARM_TRANSFER",
                    CLOSE_WON: "CLOSED_WON",
                    CLOSE_LOST: "CLOSED_LOST",
                    DNC: "SUPPRESSED_DNC",
                    SUPPRESS_DNC: "SUPPRESSED_DNC",
                },
            },
            CALLBACK_SCHEDULED: {
                on: {
                    HANDOFF_COMPLETED: "HANDED_OFF",
                    CLOSE_WON: "CLOSED_WON",
                    CLOSE_LOST: "CLOSED_LOST",
                    NOT_INTERESTED: "NOT_INTERESTED",
                    DNC: "SUPPRESSED_DNC",
                    SUPPRESS_DNC: "SUPPRESSED_DNC",
                },
            },
            WARM_TRANSFER: {
                on: {
                    HANDOFF_COMPLETED: "HANDED_OFF",
                    TRANSFER_FAILED: "CALLBACK_SCHEDULED",
                    DNC: "SUPPRESSED_DNC",
                    SUPPRESS_DNC: "SUPPRESSED_DNC",
                },
            },
            HANDED_OFF: {
                on: {
                    CLOSE_WON: "CLOSED_WON",
                    CLOSE_LOST: "CLOSED_LOST",
                    CLOSE_UNQUALIFIED: "CLOSED_UNQUALIFIED",
                    DNC: "SUPPRESSED_DNC",
                    SUPPRESS_DNC: "SUPPRESSED_DNC",
                },
            },
            NO_RESPONSE: {
                on: {
                    RE_ENGAGE: "RE_ENGAGEMENT_POOL",
                    CLOSE_LOST: "CLOSED_LOST",
                    DNC: "SUPPRESSED_DNC",
                    SUPPRESS_DNC: "SUPPRESSED_DNC",
                },
            },
            NOT_INTERESTED: {
                on: {
                    RE_ENGAGE: "RE_ENGAGEMENT_POOL",
                    CLOSE_UNQUALIFIED: "CLOSED_UNQUALIFIED",
                    CLOSE_LOST: "CLOSED_LOST",
                    DNC: "SUPPRESSED_DNC",
                    SUPPRESS_DNC: "SUPPRESSED_DNC",
                },
            },
            RE_ENGAGEMENT_POOL: {
                on: {
                    QUEUE: "QUEUED",
                    DISPATCH_EMAIL: "QUEUED",
                    DISPATCH_CALL: "QUEUED",
                    EMAIL_SENT: "CONTACTED",
                    CALL_INITIATED: "CONTACTED",
                    CLOSE_LOST: "CLOSED_LOST",
                    DNC: "SUPPRESSED_DNC",
                    SUPPRESS_DNC: "SUPPRESSED_DNC",
                },
            },
            CLOSED_WON: { type: "final" },
            CLOSED_LOST: { type: "final" },
            CLOSED_UNQUALIFIED: { type: "final" },
            SUPPRESSED_DNC: { type: "final" },
        },
    });
}

export function transitionLeadState(currentState, eventName, context = {}) {
    if (!currentState) currentState = "NEW";
    if (String(currentState).toUpperCase() === "ATTEMPTED") currentState = "CONTACTED";
    if (TERMINAL_STATES.includes(currentState)) {
        return {
            nextState: currentState,
            changed: false,
            reason: `Lead is already in terminal state ${currentState}`,
        };
    }

    if (eventName === "DNC" || eventName === "SUPPRESS_DNC") {
        return {
            nextState: "SUPPRESSED_DNC",
            changed: currentState !== "SUPPRESSED_DNC",
            reason: context.reason || "Suppression match",
        };
    }

    const machine = createLeadStateMachine(currentState);
    const actor = createActor(machine);
    actor.start();
    actor.send({ type: eventName });
    const nextState = actor.getSnapshot().value;
    actor.stop();

    const resolved = nextState || currentState;
    return {
        nextState: resolved,
        changed: resolved !== currentState,
        reason: context.reason || null,
    };
}

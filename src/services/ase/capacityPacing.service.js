import {
    CAPACITY_REASONS,
    DEEP_CALLBACK_QUEUE,
    DEFAULT_CALLS_PER_HOUR,
    DEFAULT_EMAILS_PER_HOUR,
    DIALS_PER_FREE_REP,
} from "./capacityPacing.constants.js";

export function computeMaxNewDials({ freeReps = 0, openHotCallbacks = 0 } = {}) {
    return Math.max(0, Number(freeReps || 0) * DIALS_PER_FREE_REP - Number(openHotCallbacks || 0));
}

export function isCallbackQueueDeep(overdueCallbacks = 0) {
    return Number(overdueCallbacks || 0) >= DEEP_CALLBACK_QUEUE;
}

export function countFreeReps({ salesRepCount = 0, onCallCount = 0, onlineCount = null, aseFreeCount = null } = {}) {
    if (aseFreeCount != null) {
        return Math.max(0, Number(aseFreeCount || 0));
    }
    const sales = Math.max(0, Number(salesRepCount || 0));
    const onCall = Math.max(0, Number(onCallCount || 0));
    const notOnCall = Math.max(0, sales - onCall);
    if (onlineCount != null && Number(onlineCount) > 0) {
        return Math.min(notOnCall, Number(onlineCount));
    }
    if (sales === 0) return onCall > 0 ? 0 : 1;
    return notOnCall;
}

export function readHourlyCaps(settings, envCaps = {}) {
    const capacity = settings?.capacity && typeof settings.capacity === "object" ? settings.capacity : {};
    const emailsPerHour = Number(capacity.emailsPerHour || envCaps.emailsPerHour || DEFAULT_EMAILS_PER_HOUR);
    const callsPerHour = Number(capacity.callsPerHour || envCaps.callsPerHour || DEFAULT_CALLS_PER_HOUR);
    return {
        emailsPerHour: emailsPerHour > 0 ? emailsPerHour : DEFAULT_EMAILS_PER_HOUR,
        callsPerHour: callsPerHour > 0 ? callsPerHour : DEFAULT_CALLS_PER_HOUR,
    };
}

export function evaluateCapacity({
    action,
    freeReps = 0,
    openHotCallbacks = 0,
    overdueCallbacks = 0,
    emailsThisHour = 0,
    callsThisHour = 0,
    emailsPerHour = DEFAULT_EMAILS_PER_HOUR,
    callsPerHour = DEFAULT_CALLS_PER_HOUR,
    dialsThisTick = 0,
    hasEmail = true,
    autonomous = true,
} = {}) {
    const maxNewDials = computeMaxNewDials({ freeReps, openHotCallbacks });
    const act = String(action || "").toUpperCase();

    if (!autonomous || (act !== "EMAIL" && act !== "CALL")) {
        return { allowed: true, shiftedAction: null, reason: null, maxNewDials };
    }

    const emailsCapHit = Number(emailsThisHour || 0) >= Number(emailsPerHour);
    const callsCapHit = Number(callsThisHour || 0) >= Number(callsPerHour);
    const queueDeep = isCallbackQueueDeep(overdueCallbacks);
    const remainingDials = Math.max(0, maxNewDials - Number(dialsThisTick || 0));

    if (act === "CALL") {
        if (queueDeep || remainingDials <= 0 || callsCapHit) {
            const shiftedAction = hasEmail && !emailsCapHit ? "EMAIL" : "WAIT";
            const reason = queueDeep
                ? CAPACITY_REASONS.CALLBACK_QUEUE_DEEP
                : callsCapHit
                    ? CAPACITY_REASONS.CALLS_PER_HOUR_CAP
                    : CAPACITY_REASONS.NO_DIAL_CAPACITY;
            return { allowed: false, shiftedAction, reason, maxNewDials };
        }
        return { allowed: true, shiftedAction: null, reason: null, maxNewDials };
    }

    if (act === "EMAIL" && emailsCapHit) {
        return {
            allowed: false,
            shiftedAction: "WAIT",
            reason: CAPACITY_REASONS.EMAILS_PER_HOUR_CAP,
            maxNewDials,
        };
    }

    return { allowed: true, shiftedAction: null, reason: null, maxNewDials };
}

export function engineMayAddAutonomousCall(snapshot = {}) {
    return evaluateCapacity({ ...snapshot, action: "CALL", autonomous: true, hasEmail: false }).allowed;
}

import {
    applyCapsExhaust,
    applyQuietClose,
    applyTerminalClose,
    getLifecycleConfig,
    sanitizeIllegalLifecycle,
    sweepLifecycle,
} from "./lifecycleClose.service.js";
import {
    engineMayContact,
    evaluateCapsExhaust,
    evaluateQuietClose,
    isOutreachStopped,
    sanitizeNextAction,
} from "./lifecycle.service.js";
import { LIFECYCLE_REASONS } from "./lifecycle.constants.js";

export async function applyLifecycleGate(lead, action, options = {}) {
    if (!lead) {
        return { allowed: false, reason: "Lead record not found", lead };
    }

    let working = lead;
    const sanitized = await sanitizeIllegalLifecycle(working);
    if (sanitized.changed) working = sanitized.lead || working;

    if (isOutreachStopped(working)) {
        if (working.next_action || working.next_action_time) {
            await applyTerminalClose(working, {
                status: working.do_not_contact ? "SUPPRESSED_DNC" : working.status,
                reason: working.do_not_contact ? "Do not contact" : `Lead is in terminal state ${working.status}`,
            }).catch(() => null);
        }
        const contact = engineMayContact(working, action);
        return { allowed: false, reason: contact.reason, lead: working, closed: true };
    }

    const config = await getLifecycleConfig(working.organization_id || options.organizationId || 1);
    const caps = evaluateCapsExhaust(working, config);
    if (caps.exhausted) {
        const closed = await applyCapsExhaust(working, config);
        return {
            allowed: false,
            reason: LIFECYCLE_REASONS.CAPS_EXHAUSTED,
            lead: closed.lead || working,
            closed: true,
        };
    }

    const autonomous = !options.force && !options.manual && !options.approved;
    if (autonomous) {
        const quiet = evaluateQuietClose(working, { quietDays: config.quietDays });
        if (quiet.quiet) {
            const closed = await applyQuietClose(working, config);
            return {
                allowed: false,
                reason: LIFECYCLE_REASONS.QUIET_DAYS,
                lead: closed.lead || working,
                closed: true,
            };
        }
    }

    const next = sanitizeNextAction(action || working.next_action);
    if (next === "WAIT" && String(action || "").toUpperCase() === "ATTEMPTED") {
        return { allowed: false, reason: LIFECYCLE_REASONS.ILLEGAL_ATTEMPTED, lead: working, sanitized: true };
    }

    const contact = engineMayContact(working, next);
    if (!contact.allowed && next !== "WAIT" && next !== "REP_CALLBACK") {
        return { allowed: false, reason: contact.reason, lead: working };
    }

    return { allowed: true, reason: null, lead: working };
}

export async function applyLifecycleSweep(limit = 20) {
    return sweepLifecycle(limit);
}

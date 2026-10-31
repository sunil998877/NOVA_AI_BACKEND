import { query } from "../../config/db.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Callback } from "../../models/callback.model.js";
import { eventBus } from "./eventBus.service.js";
import { haltOutreachForLead } from "./outreachHalt.service.js";
import { transitionLeadState } from "./leadStateMachine.js";
import { env } from "../../config/env.js";
import {
    AFTER_NO_RESPONSE,
    ASE_STATES,
    DEFAULT_QUIET_DAYS,
    HEALTH,
    LIFECYCLE_REASONS,
} from "./lifecycle.constants.js";
import {
    computeHealth,
    evaluateCapsExhaust,
    evaluateQuietClose,
    isIllegalStatus,
    isOutreachStopped,
    isTerminalStatus,
    readLifecycleConfig,
    sanitizeNextAction,
    sanitizeStatus,
} from "./lifecycle.service.js";

function parseSettings(raw) {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

const configCache = new Map();
const CONFIG_TTL_MS = 8000;

async function loadOrgSettings(orgId) {
    try {
        const rows = await query("SELECT settings FROM organizations WHERE id = ? LIMIT 1", [Number(orgId)]);
        return parseSettings(rows?.[0]?.settings);
    } catch {
        return {};
    }
}

export async function getLifecycleConfig(orgId) {
    const id = Number(orgId || 1);
    const cached = configCache.get(id);
    if (cached && cached.expires > Date.now()) return cached.config;
    const settings = await loadOrgSettings(id);
    const config = readLifecycleConfig(settings, {
        quietDays: env.quietDays || DEFAULT_QUIET_DAYS,
    });
    configCache.set(id, { expires: Date.now() + CONFIG_TTL_MS, config });
    return config;
}

export function clearLifecycleConfig(orgId = null) {
    if (orgId == null) {
        configCache.clear();
        return;
    }
    configCache.delete(Number(orgId));
}

async function persistLead(lead, fields, orgId) {
    await Lead.updateById(lead.id, fields, orgId).catch(() => null);
    return { ...lead, ...fields };
}

async function emitLifecycle(lead, orgId, eventType, payload) {
    await eventBus.publish("LeadStateChanged", {
        organization_id: orgId,
        lead_id: lead.id,
        channel: "SYSTEM",
        from_state: payload.from_state || lead.status,
        to_state: payload.to_state || payload.status,
        reason: payload.reason,
        ...payload,
    }).catch(() => {});

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        channel: "SYSTEM",
        event_type: eventType,
        status: payload.to_state || payload.status || "UPDATED",
        payload,
        idempotency_key: `${eventType}_${orgId}_${lead.id}_${String(payload.reason || payload.to_state || "").slice(0, 40)}`,
    }).catch(() => {});
}

export async function applyLeadHealth(lead, extras = {}) {
    if (!lead?.id) return lead;
    const orgId = Number(lead.organization_id || extras.organizationId || 1);
    const health = computeHealth(lead, extras);
    if (health === lead.health) return lead;
    return persistLead(lead, { health }, orgId);
}

export async function sanitizeIllegalLifecycle(lead) {
    if (!lead?.id) return { changed: false, lead };
    const orgId = Number(lead.organization_id || 1);
    const nextStatus = sanitizeStatus(lead.status);
    const nextAction = sanitizeNextAction(lead.next_action);
    const statusChanged = nextStatus !== String(lead.status || "").toUpperCase() || isIllegalStatus(lead.status);
    const actionChanged = nextAction !== (lead.next_action == null ? null : String(lead.next_action).toUpperCase())
        || String(lead.next_action || "").toUpperCase() === "ATTEMPTED";

    if (!statusChanged && !actionChanged) {
        return { changed: false, lead };
    }

    const fields = {};
    if (statusChanged) fields.status = nextStatus;
    if (actionChanged) {
        fields.next_action = nextAction;
        if (nextAction === "WAIT" && !lead.next_action_time) {
            fields.next_action_time = new Date(Date.now() + 15 * 60 * 1000);
        }
        if (nextAction == null) fields.next_action_time = null;
    }
    const updated = await persistLead(lead, fields, orgId);
    await emitLifecycle(lead, orgId, "ILLEGAL_STATE_SANITIZED", {
        from_state: lead.status,
        to_state: nextStatus,
        from_action: lead.next_action,
        to_action: nextAction,
        reason: LIFECYCLE_REASONS.ILLEGAL_ATTEMPTED,
    });
    return { changed: true, lead: updated };
}

export async function applyTerminalClose(lead, {
    status,
    reason = "Terminal close",
    eventName = null,
} = {}) {
    if (!lead?.id) return { closed: false, lead };
    const orgId = Number(lead.organization_id || 1);
    const target = sanitizeStatus(status || lead.status);
    const transition = eventName
        ? transitionLeadState(lead.status, eventName, { reason })
        : { nextState: target, changed: String(lead.status) !== target, reason };
    const nextStatus = isTerminalStatus(target) ? target : transition.nextState;
    const health = nextStatus === ASE_STATES.CLOSED_WON ? HEALTH.GREEN : HEALTH.AMBER;

    const updated = await persistLead(lead, {
        status: nextStatus,
        next_action: null,
        next_action_time: null,
        health,
        ...(nextStatus === ASE_STATES.SUPPRESSED_DNC ? { do_not_contact: 1 } : {}),
    }, orgId);

    const halted = await haltOutreachForLead(orgId, lead.id, reason).catch(() => ({ cancelledExecutions: 0, cancelledApprovals: 0 }));
    await emitLifecycle(lead, orgId, "LIFECYCLE_CLOSED", {
        from_state: lead.status,
        to_state: nextStatus,
        reason,
        cancelledExecutions: halted.cancelledExecutions,
        cancelledApprovals: halted.cancelledApprovals,
        cancelledCallbacks: halted.cancelledCallbacks,
    });
    return { closed: true, halted: true, lead: updated, status: nextStatus };
}

async function applyPolicyAfter(lead, {
    firstEvent,
    policy,
    reason,
    eventType,
}) {
    const orgId = Number(lead.organization_id || 1);
    const first = transitionLeadState(lead.status, firstEvent, { reason });
    const policyEvent = policy === AFTER_NO_RESPONSE.RE_ENGAGEMENT_POOL ? "RE_ENGAGE" : "CLOSE_LOST";
    const second = transitionLeadState(first.nextState, policyEvent, { reason });
    const nextStatus = second.nextState;
    const terminal = isTerminalStatus(nextStatus);
    const health = computeHealth({ ...lead, status: nextStatus, next_action: null });

    const updated = await persistLead(lead, {
        status: nextStatus,
        next_action: null,
        next_action_time: null,
        health,
    }, orgId);

    await haltOutreachForLead(orgId, lead.id, reason).catch(() => null);
    await emitLifecycle(lead, orgId, eventType, {
        from_state: lead.status,
        to_state: nextStatus,
        via: first.nextState,
        policy,
        reason,
        halted: true,
        terminal,
    });
    return { closed: terminal, pooled: nextStatus === ASE_STATES.RE_ENGAGEMENT_POOL, lead: updated, status: nextStatus };
}

export async function applyCadenceClose(lead, { closeOutcome = "NURTURE", reason = "Cadence finished without engagement" } = {}) {
    if (!lead?.id || isOutreachStopped(lead)) return { applied: false, lead };
    const policy = closeOutcome === "CLOSED_LOST" ? AFTER_NO_RESPONSE.CLOSED_LOST : AFTER_NO_RESPONSE.RE_ENGAGEMENT_POOL;
    const result = await applyPolicyAfter(lead, {
        firstEvent: "NO_RESPONSE",
        policy,
        reason,
        eventType: policy === AFTER_NO_RESPONSE.RE_ENGAGEMENT_POOL ? "LIFECYCLE_RE_ENGAGE" : "LIFECYCLE_NO_RESPONSE",
    });
    return { applied: true, ...result };
}

export async function applyCapsExhaust(lead, config) {
    const cfg = config || await getLifecycleConfig(lead.organization_id);
    const caps = evaluateCapsExhaust(lead, cfg);
    if (!caps.exhausted) return { applied: false, lead };
    const result = await applyPolicyAfter(lead, {
        firstEvent: "NO_RESPONSE",
        policy: cfg.afterNoResponse,
        reason: "3 email + 2 call with no reply",
        eventType: cfg.afterNoResponse === AFTER_NO_RESPONSE.RE_ENGAGEMENT_POOL
            ? "LIFECYCLE_RE_ENGAGE"
            : "LIFECYCLE_NO_RESPONSE",
    });
    return { applied: true, ...result };
}

export async function applyQuietClose(lead, config) {
    const cfg = config || await getLifecycleConfig(lead.organization_id);
    const quiet = evaluateQuietClose(lead, { quietDays: cfg.quietDays });
    if (!quiet.quiet) return { applied: false, lead };
    const result = await applyPolicyAfter(lead, {
        firstEvent: "NO_RESPONSE",
        policy: cfg.afterQuietDays,
        reason: `No activity for ${cfg.quietDays} quiet days`,
        eventType: cfg.afterQuietDays === AFTER_NO_RESPONSE.RE_ENGAGEMENT_POOL
            ? "LIFECYCLE_RE_ENGAGE"
            : "LIFECYCLE_CLOSED",
    });
    return { applied: true, ...result };
}

export async function sweepLifecycle(limit = 20) {
    const illegal = await Lead.findIllegalLifecycle(limit).catch(() => []);
    let sanitized = 0;
    for (const lead of illegal) {
        const result = await sanitizeIllegalLifecycle(lead);
        if (result.changed) sanitized += 1;
    }

    const floorCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stale = await Lead.findQuietForClose({ quietBefore: floorCutoff, limit }).catch(() => []);
    let closed = 0;
    const seen = new Set();
    for (const lead of stale) {
        if (seen.has(lead.id) || isOutreachStopped(lead)) continue;
        seen.add(lead.id);
        const config = await getLifecycleConfig(lead.organization_id);
        const quiet = evaluateQuietClose(lead, { quietDays: config.quietDays });
        if (!quiet.quiet) continue;
        const result = await applyQuietClose(lead, config);
        if (result.applied) closed += 1;
    }

    return { sanitized, closed };
}

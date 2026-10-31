import { query } from "../../config/db.js";
import { User } from "../../models/user.model.js";
import { Call } from "../../models/call.model.js";
import { Callback } from "../../models/callback.model.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { env } from "../../config/env.js";
import { jobQueue } from "./jobQueue.service.js";
import { asePresenceStore } from "../../socket/asePresence.store.js";
import { countAseFreeNow, hasLiveAsePresence } from "./asePresence.service.js";
import { eventBus } from "./eventBus.service.js";
import {
    CAPACITY_RETRY_MS,
    SNAPSHOT_TTL_MS,
} from "./capacityPacing.constants.js";
import {
    countFreeReps,
    evaluateCapacity,
    readHourlyCaps,
} from "./capacityPacing.service.js";

const snapshotCache = new Map();

function parseSettings(raw) {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

async function loadOrgSettings(orgId) {
    try {
        const rows = await query("SELECT settings FROM organizations WHERE id = ? LIMIT 1", [Number(orgId)]);
        return parseSettings(rows?.[0]?.settings);
    } catch {
        return {};
    }
}

function aseFreeForOrg(orgId) {
    const live = asePresenceStore.listByOrg(orgId);
    if (!hasLiveAsePresence(live)) return { aseFreeCount: null, onlineCount: null };
    return {
        aseFreeCount: countAseFreeNow(live),
        onlineCount: live.filter((row) => Number(row.socketCount || 0) > 0).length,
    };
}

export async function getCapacitySnapshot(orgId) {
    const id = Number(orgId || 1);
    const cached = snapshotCache.get(id);
    if (cached && cached.expires > Date.now()) return cached.snapshot;

    const [salesReps, onCallCount, callbackStats, hourly, settings] = await Promise.all([
        User.listSalesRepIds(id).catch(() => []),
        Call.countActiveOutbound(id).catch(() => 0),
        Callback.countStats(id).catch(() => ({ open_count: 0, overdue_count: 0 })),
        LeadEvent.countHourlyDispatches(id).catch(() => ({ email: 0, voice: 0 })),
        loadOrgSettings(id),
    ]);

    const caps = readHourlyCaps(settings, {
        emailsPerHour: env.emailsPerHour,
        callsPerHour: env.callsPerHour,
    });
    const ase = aseFreeForOrg(id);
    const openCount = Number(callbackStats.open_count || 0);
    const overdueCallbacks = Number(callbackStats.overdue_count || 0);
    const snapshot = {
        organizationId: id,
        salesRepCount: salesReps.length,
        onCallCount: Number(onCallCount || 0) + Number(jobQueue.getVoiceInFlight?.() || 0),
        onlineCount: ase.onlineCount,
        aseFreeCount: ase.aseFreeCount,
        openHotCallbacks: openCount + overdueCallbacks,
        overdueCallbacks,
        emailsThisHour: Number(hourly.email || 0),
        callsThisHour: Number(hourly.voice || 0),
        emailsPerHour: caps.emailsPerHour,
        callsPerHour: caps.callsPerHour,
        dialsThisTick: 0,
        freeReps: 0,
    };
    snapshot.freeReps = countFreeReps(snapshot);

    snapshotCache.set(id, { expires: Date.now() + SNAPSHOT_TTL_MS, snapshot });
    return snapshot;
}

export function clearCapacitySnapshot(orgId = null) {
    if (orgId == null) {
        snapshotCache.clear();
        return;
    }
    snapshotCache.delete(Number(orgId));
}

export async function applyCapacityGate(lead, action, options = {}) {
    const autonomous = !options.force && !options.manual && !options.approved;
    const snapshot = await getCapacitySnapshot(lead?.organization_id || options.organizationId || 1);
    const verdict = evaluateCapacity({
        ...snapshot,
        action,
        hasEmail: Boolean(lead?.email),
        autonomous,
    });
    const reserve = options.reserve !== false;
    if (reserve && verdict.allowed && String(action || "").toUpperCase() === "CALL" && autonomous) {
        snapshot.dialsThisTick += 1;
        snapshot.callsThisHour += 1;
    }
    if (reserve && verdict.allowed && String(action || "").toUpperCase() === "EMAIL" && autonomous) {
        snapshot.emailsThisHour += 1;
    }
    return { ...verdict, autonomous, snapshot };
}

export async function applyCapacityShift(lead, verdict) {
    const orgId = Number(lead.organization_id || 1);
    const shifted = String(verdict.shiftedAction || "WAIT").toUpperCase();
    const nextAction = shifted === "EMAIL" ? "EMAIL" : "WAIT";
    const nextTime = shifted === "EMAIL"
        ? new Date()
        : new Date(Date.now() + CAPACITY_RETRY_MS);

    await Lead.updateById(
        lead.id,
        { next_action: nextAction, next_action_time: nextTime },
        orgId
    ).catch(() => null);

    await eventBus.publish("ActionFailed", {
        organization_id: orgId,
        lead_id: lead.id,
        channel: "SYSTEM",
        action: lead.next_action,
        status: "DEFERRED",
        reason: verdict.reason,
        shifted_to: nextAction,
        event_type_hint: "CAPACITY_DEFERRED",
    }).catch(() => {});

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        channel: "SYSTEM",
        event_type: "CAPACITY_DEFERRED",
        status: "DEFERRED",
        payload: {
            reason: verdict.reason,
            from_action: lead.next_action,
            shifted_to: nextAction,
            max_new_dials: verdict.maxNewDials,
            overdue_callbacks: verdict.snapshot?.overdueCallbacks,
        },
        idempotency_key: `capacity_${orgId}_${lead.id}_${verdict.reason}_${nextAction}`,
    }).catch(() => {});

    return { nextAction, nextTime };
}

import { query, execute } from "../../config/db.js";
import { User } from "../../models/user.model.js";
import { Lead } from "../../models/lead.model.js";
import { Callback } from "../../models/callback.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { eventBus } from "./eventBus.service.js";
import { pickRep } from "./routing.service.js";
import { ROUTING_STRATEGIES } from "./routing.constants.js";

const cursorCache = new Map();

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
    const rows = await query("SELECT settings FROM organizations WHERE id = ? LIMIT 1", [Number(orgId)]);
    if (!rows?.length) return null;
    return parseSettings(rows[0].settings);
}

async function saveRoundRobinCursor(orgId, cursor) {
    const id = Number(orgId || 1);
    cursorCache.set(id, Number(cursor) || 0);
    try {
        const settings = await loadOrgSettings(id);
        if (!settings) return;
        const next = {
            ...settings,
            routing: {
                ...(settings.routing && typeof settings.routing === "object" ? settings.routing : {}),
                roundRobinCursor: Number(cursor) || 0,
            },
        };
        await execute("UPDATE organizations SET settings = ? WHERE id = ?", [JSON.stringify(next), id]);
    } catch (err) {
        console.warn("[ASE] Could not persist routing cursor:", err.message);
    }
}

function overlayRep(user, overlays = {}) {
    const extra = overlays[String(user.id)] || overlays[Number(user.id)] || {};
    return {
        id: Number(user.id),
        role: user.role,
        fullName: user.fullName,
        team: extra.team || user.team || null,
        territory: extra.territory || extra.territories || user.territory || null,
        territories: extra.territories || extra.territory || user.territory || null,
        openCallbacks: Number(user.openCallbacks || 0),
    };
}

export async function loadRoutableReps(orgId) {
    const id = Number(orgId || 1);
    const [users, workloads, settings] = await Promise.all([
        User.listRoutableReps(id).catch(() => []),
        Callback.countOpenByRep(id).catch(() => ({})),
        loadOrgSettings(id).catch(() => null),
    ]);
    const overlays = settings?.routing?.reps && typeof settings.routing.reps === "object"
        ? settings.routing.reps
        : {};
    return (users || []).map((user) => overlayRep({
        ...user,
        openCallbacks: Number(workloads[Number(user.id)] || 0),
    }, overlays));
}

export async function routeHotLead(lead, options = {}) {
    const orgId = Number(lead?.organization_id || options.organizationId || 1);
    const reps = options.reps || await loadRoutableReps(orgId);
    const cachedCursor = cursorCache.has(orgId)
        ? cursorCache.get(orgId)
        : Number((await loadOrgSettings(orgId).catch(() => null))?.routing?.roundRobinCursor || 0);
    const verdict = pickRep({
        lead,
        reps,
        cursor: cachedCursor,
        keepAssigned: options.keepAssigned !== false,
    });

    if (verdict.rep && verdict.strategy !== ROUTING_STRATEGIES.EXISTING) {
        await saveRoundRobinCursor(orgId, verdict.cursor);
        if (options.bumpWorkload !== false) {
            verdict.rep.openCallbacks = Number(verdict.rep.openCallbacks || 0) + 1;
        }
    }

    return {
        ...verdict,
        organizationId: orgId,
        assignedRepId: verdict.rep ? Number(verdict.rep.id) : null,
    };
}

export async function applyHotLeadAssignment(lead, options = {}) {
    const orgId = Number(lead?.organization_id || options.organizationId || 1);
    const routed = await routeHotLead(lead, options);
    const assignedRepId = routed.assignedRepId;
    if (routed.strategy === ROUTING_STRATEGIES.EXISTING && assignedRepId) {
        return { ...routed, lead };
    }

    if (assignedRepId && Number(lead.assigned_rep_id) !== assignedRepId) {
        await Lead.updateById(lead.id, { assigned_rep_id: assignedRepId }, orgId).catch(() => null);
    }

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        channel: "SYSTEM",
        event_type: routed.alert ? "ROUTING_UNASSIGNED" : "ROUTING_ASSIGNED",
        status: routed.alert ? "UNASSIGNED" : "ASSIGNED",
        payload: {
            strategy: routed.strategy,
            assigned_rep_id: assignedRepId,
            reason: options.reason || "hot_lead",
        },
        idempotency_key: `routing_${orgId}_${lead.id}_${routed.strategy}_${assignedRepId || "none"}`,
    }).catch(() => {});

    if (routed.alert) {
        await eventBus.publish("ActionFailed", {
            organization_id: orgId,
            lead_id: lead.id,
            channel: "SYSTEM",
            status: "UNASSIGNED",
            reason: "No routable rep available for hot lead",
            strategy: routed.strategy,
        }).catch(() => {});
    }

    return {
        ...routed,
        lead: assignedRepId ? { ...lead, assigned_rep_id: assignedRepId } : lead,
    };
}

export async function routeUnassignedHandoffs(orgId) {
    const id = Number(orgId || 1);
    let rows = [];
    try {
        rows = await query(
            `SELECT id, organization_id, assigned_rep_id, status, next_action, callback_due,
                    segment_attributes, metadata
             FROM leads
             WHERE organization_id = ?
               AND do_not_contact = 0
               AND assigned_rep_id IS NULL
               AND status NOT IN ('CLOSED_WON', 'CLOSED_LOST', 'CLOSED_UNQUALIFIED', 'SUPPRESSED_DNC')
               AND (status = 'CALLBACK_SCHEDULED' OR next_action = 'REP_CALLBACK' OR callback_due IS NOT NULL)`,
            [id]
        );
    } catch {
        return { assigned: 0 };
    }

    let assigned = 0;
    for (const row of rows || []) {
        const parseJson = (value) => {
            if (!value) return {};
            if (typeof value === "object") return value;
            try {
                return JSON.parse(value);
            } catch {
                return {};
            }
        };
        const lead = {
            ...row,
            segment_attributes: parseJson(row.segment_attributes),
            metadata: parseJson(row.metadata),
        };
        const result = await applyHotLeadAssignment(lead, { reason: "callback_backfill" });
        if (result.assignedRepId) assigned += 1;
    }
    return { assigned };
}

export function resetRoutingCursor(orgId = null) {
    if (orgId == null) {
        cursorCache.clear();
        return;
    }
    cursorCache.delete(Number(orgId));
}

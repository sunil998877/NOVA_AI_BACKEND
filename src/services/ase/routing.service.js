import { ROUTING_STRATEGIES } from "./routing.constants.js";

function tokensFrom(...values) {
    const out = [];
    for (const value of values) {
        if (value == null || value === "") continue;
        if (Array.isArray(value)) {
            out.push(...tokensFrom(...value));
            continue;
        }
        String(value)
            .split(/[,|/]+/)
            .map((part) => part.trim().toLowerCase())
            .filter((part) => part && part !== "—" && part !== "-")
            .forEach((part) => out.push(part));
    }
    return [...new Set(out)];
}

export function leadTerritory(lead = {}) {
    const attrs = lead.segment_attributes && typeof lead.segment_attributes === "object"
        ? lead.segment_attributes
        : {};
    const meta = lead.metadata && typeof lead.metadata === "object" ? lead.metadata : {};
    return tokensFrom(
        lead.city,
        lead.state,
        lead.location,
        attrs.city,
        attrs.state,
        attrs.region,
        attrs.territory,
        meta.city,
        meta.state,
        meta.location,
        meta.region,
        meta.territory
    );
}

export function leadTeam(lead = {}) {
    const attrs = lead.segment_attributes && typeof lead.segment_attributes === "object"
        ? lead.segment_attributes
        : {};
    const meta = lead.metadata && typeof lead.metadata === "object" ? lead.metadata : {};
    const raw = lead.team || attrs.team || meta.team || null;
    return raw ? String(raw).trim().toLowerCase() : null;
}

export function repTerritories(rep = {}) {
    return tokensFrom(rep.territories, rep.territory);
}

function matchesTerritory(rep, territoryTokens) {
    if (!territoryTokens.length) return false;
    const owned = repTerritories(rep);
    if (!owned.length) return false;
    return owned.some((token) => territoryTokens.some((leadToken) => (
        token === leadToken || token.includes(leadToken) || leadToken.includes(token)
    )));
}

function matchesTeam(rep, team) {
    if (!team) return false;
    return String(rep.team || "").trim().toLowerCase() === team;
}

export function nextRoundRobin(reps, cursor = 0) {
    const sorted = [...reps].sort((a, b) => Number(a.id) - Number(b.id));
    if (!sorted.length) return { rep: null, cursor: Number(cursor) || 0 };
    const lastId = Number(cursor) || 0;
    const idx = sorted.findIndex((rep) => Number(rep.id) === lastId);
    const next = sorted[(idx + 1) % sorted.length];
    return { rep: next, cursor: Number(next.id) };
}

export function pickRep({
    lead = {},
    reps = [],
    cursor = 0,
    keepAssigned = true,
} = {}) {
    const pool = (reps || []).filter((rep) => Number(rep.id));
    if (keepAssigned && lead.assigned_rep_id) {
        const existing = pool.find((rep) => Number(rep.id) === Number(lead.assigned_rep_id));
        if (existing) {
            return { rep: existing, strategy: ROUTING_STRATEGIES.EXISTING, cursor, alert: false };
        }
    }

    if (!pool.length) {
        return { rep: null, strategy: ROUTING_STRATEGIES.UNASSIGNED, cursor, alert: true };
    }

    const territory = leadTerritory(lead);
    const team = leadTeam(lead);
    let strategy = ROUTING_STRATEGIES.ROUND_ROBIN;
    let candidates = pool;

    const byTerritory = candidates.filter((rep) => matchesTerritory(rep, territory));
    if (byTerritory.length) {
        candidates = byTerritory;
        strategy = ROUTING_STRATEGIES.TERRITORY;
    }

    const byTeam = candidates.filter((rep) => matchesTeam(rep, team));
    if (byTeam.length) {
        candidates = byTeam;
        strategy = strategy === ROUTING_STRATEGIES.TERRITORY ? ROUTING_STRATEGIES.TERRITORY : ROUTING_STRATEGIES.TEAM;
    }

    const minLoad = Math.min(...candidates.map((rep) => Number(rep.openCallbacks || 0)));
    const lightest = candidates.filter((rep) => Number(rep.openCallbacks || 0) === minLoad);
    if (lightest.length < candidates.length) {
        strategy = strategy === ROUTING_STRATEGIES.ROUND_ROBIN ? ROUTING_STRATEGIES.WORKLOAD : strategy;
        candidates = lightest;
    } else {
        candidates = lightest;
    }

    const picked = nextRoundRobin(candidates, cursor);
    return {
        rep: picked.rep,
        strategy,
        cursor: picked.cursor,
        alert: false,
    };
}

export function simulateEvenRouting(repIds, count) {
    const reps = (repIds || []).map((id) => ({ id: Number(id), openCallbacks: 0 }));
    let cursor = 0;
    const assigned = [];
    for (let i = 0; i < count; i += 1) {
        const result = pickRep({ lead: {}, reps, cursor, keepAssigned: false });
        if (!result.rep) break;
        result.rep.openCallbacks += 1;
        cursor = result.cursor;
        assigned.push(Number(result.rep.id));
    }
    return assigned;
}

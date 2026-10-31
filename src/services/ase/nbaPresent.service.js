const BRAIN_EVENT_TYPES = new Set([
    "NOVA_BRAIN_DECISION",
    "DECISION_EVALUATED",
    "ORCHESTRATOR_DECISION",
]);

const CADENCE_BY_EMAILS = Object.freeze([
    "First email",
    "Day 2 follow-up",
    "Day 7 follow-up",
    "Day 14 follow-up",
    "Day 28 follow-up",
    "Day 42 follow-up",
]);

const CHANNEL_LABEL = Object.freeze({
    EMAIL: "Email",
    CALL: "Call",
    REP_CALLBACK: "Callback",
    WAIT: "Wait",
});

function upper(value) {
    return String(value || "").trim().toUpperCase();
}

function toFraction(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    return number > 1 ? number / 100 : number;
}

function rankedToMap(ranked) {
    if (!Array.isArray(ranked)) return {};
    return Object.fromEntries(
        ranked
            .filter((item) => item && item.action != null)
            .map((item) => [upper(item.action), item.probability])
    );
}

function probsFromExplanation(text) {
    if (!text) return null;
    const email = String(text).match(/email\s+(\d+(?:\.\d+)?)%/i);
    const call = String(text).match(/call\s+(\d+(?:\.\d+)?)%/i);
    const wait = String(text).match(/wait\s+(\d+(?:\.\d+)?)%/i);
    if (!email && !call && !wait) return null;
    return {
        EMAIL: email ? Number(email[1]) / 100 : 0,
        CALL: call ? Number(call[1]) / 100 : 0,
        WAIT: wait ? Number(wait[1]) / 100 : 0,
    };
}

function actionFromExplanation(text) {
    const match = String(text || "").match(/selected\s+(EMAIL|CALL|WAIT)\b/i);
    return match ? match[1].toUpperCase() : null;
}

function parseEventPayload(event) {
    const raw = event?.payload;
    if (!raw) return {};
    if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return {}; }
    }
    return typeof raw === "object" ? raw : {};
}

export function loggedDecisionFromTimeline(timeline) {
    const events = Array.isArray(timeline) ? timeline : [];
    const latest = events
        .filter((event) => BRAIN_EVENT_TYPES.has(upper(event.event_type || event.type)))
        .sort((a, b) => {
            const left = new Date(a.created_at || a.createdAt || a.timestamp || 0).getTime();
            const right = new Date(b.created_at || b.createdAt || b.timestamp || 0).getTime();
            return right - left;
        })[0];
    return latest ? parseEventPayload(latest) : null;
}

export function channelize(action) {
    const next = upper(action);
    if (next === "EMAIL") return "EMAIL";
    if (next === "CALL" || next === "VOICE") return "CALL";
    if (next === "REP_CALLBACK") return "REP_CALLBACK";
    return null;
}

export function channelPercents(decision = {}) {
    const source = {
        ...probsFromExplanation(decision.explanation || decision.reasonSummary),
        ...rankedToMap(decision.rankedActions || decision.ranked_actions),
        ...(decision.probabilities && typeof decision.probabilities === "object" ? decision.probabilities : {}),
    };
    const email = toFraction(source.EMAIL ?? source.email) ?? 0;
    const wait = toFraction(source.WAIT ?? source.wait) ?? 0;
    const call = toFraction(source.CALL ?? source.VOICE ?? source.call) ?? 0;
    const sum = email + wait + call;
    if (sum <= 0) return { email: 0, wait: 0, call: 0, hasData: false };
    const raw = {
        email: Math.round((email / sum) * 100),
        wait: Math.round((wait / sum) * 100),
        call: Math.round((call / sum) * 100),
    };
    const drift = 100 - (raw.email + raw.wait + raw.call);
    const winner = email >= wait && email >= call ? "email" : wait >= call ? "wait" : "call";
    raw[winner] += drift;
    return { ...raw, hasData: true };
}

function winnerFromPercents(percents) {
    if (!percents?.hasData) return null;
    if (percents.email >= percents.call && percents.email >= percents.wait) return "EMAIL";
    if (percents.call >= percents.email && percents.call >= percents.wait) return "CALL";
    return null;
}

export function resolveNbaChannel({ storedAction, decision = {}, lead = {} } = {}) {
    const stored = channelize(storedAction);
    if (stored === "REP_CALLBACK" || upper(lead.status) === "CALLBACK_SCHEDULED") {
        return "REP_CALLBACK";
    }
    const model = channelize(decision.action || decision.recommendedAction || decision.channel);
    const explained = channelize(actionFromExplanation(decision.explanation || decision.reasonSummary));
    const fromProbs = winnerFromPercents(channelPercents(decision));
    if (stored) return stored;
    return model || explained || fromProbs || (lead.email ? "EMAIL" : lead.phone ? "CALL" : "WAIT");
}

export function cadenceFromCounters(lead = {}, decision = {}, cadenceStep = null) {
    if (cadenceStep) {
        if (typeof cadenceStep === "string") return cadenceStep;
        if (cadenceStep.name) return cadenceStep.name;
        if (cadenceStep.dayOffset != null) return `Day ${cadenceStep.dayOffset} follow-up`;
        if (cadenceStep.stepNumber != null) return CADENCE_BY_EMAILS[Number(cadenceStep.stepNumber)] || `Step ${cadenceStep.stepNumber}`;
    }
    const raw = typeof lead.attempt_counters === "string"
        ? (() => { try { return JSON.parse(lead.attempt_counters || "{}"); } catch { return {}; } })()
        : (lead.attempt_counters || {});
    const emails = Math.max(
        Number(raw.email || 0) || 0,
        Number(decision.supportingMetrics?.emailAttempts || decision.emailAttempts || 0) || 0
    );
    if (emails <= 0) return CADENCE_BY_EMAILS[0];
    return CADENCE_BY_EMAILS[Math.min(emails, CADENCE_BY_EMAILS.length - 1)];
}

export function formatWaitUntil(value, timeZone = "Asia/Kolkata", now = new Date()) {
    if (!value) return "Ready now";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "Ready now";
    if (date.getTime() <= new Date(now).getTime() + 15 * 1000) return "Due now";
    const day = date.toLocaleDateString("en-US", { weekday: "short", timeZone });
    const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
    const zone = timeZone === "Asia/Kolkata" ? "IST" : String(timeZone).split("/").pop().replace(/_/g, " ");
    return `Wait until ${day} ${time} ${zone}`;
}

function pickWaitUntil(lead, decision) {
    const candidates = [
        lead?.next_action_time,
        decision?.scheduledTime,
        decision?.sendWindow?.start,
    ];
    for (const value of candidates) {
        if (!value) continue;
        const date = new Date(value);
        if (!Number.isNaN(date.getTime())) return date;
    }
    return null;
}

export function isDueAt(waitUntil, now = new Date()) {
    if (!waitUntil) return true;
    const date = waitUntil instanceof Date ? waitUntil : new Date(waitUntil);
    if (Number.isNaN(date.getTime())) return true;
    return date.getTime() <= new Date(now).getTime() + 15 * 1000;
}

function headingFor(channel) {
    const label = CHANNEL_LABEL[channel] || CHANNEL_LABEL.WAIT;
    return `Next Best Action: ${label}`;
}

export function isLeadOnHold(lead) {
    const hold = lead?.metadata?.outreach_hold;
    return Boolean(hold && (hold.held === true || hold.held === 1 || hold.held === "1"));
}

function primaryFor({ channel, due, operatingMode, pendingApproval, held }) {
    const mode = upper(operatingMode) || "FULLY_AUTOMATED";
    const pending = pendingApproval?.status === "PENDING";
    if (channel === "REP_CALLBACK") {
        return { kind: "CALLBACK", label: "Open callback queue" };
    }
    if (held) {
        return { kind: "UNHOLD", label: "Unhold" };
    }
    if (!due) {
        return { kind: "HOLD", label: "Hold for now" };
    }
    if (mode === "AI_RECOMMENDED") {
        return {
            kind: "APPROVE",
            label: pending
                ? (channel === "CALL" ? "Approve & call" : "Approve & send")
                : (channel === "CALL" ? "Approve & call" : "Approve & send"),
        };
    }
    if (mode === "HUMAN_ESCALATION") {
        return { kind: "SEND", label: channel === "CALL" ? "Send call now" : "Send now" };
    }
    return { kind: "SEND", label: channel === "CALL" ? "Start AI voice call" : "Send follow-up" };
}

export function presentNba({
    lead = {},
    decision = {},
    cadenceStep = null,
    operatingMode = "FULLY_AUTOMATED",
    pendingApproval = null,
    now = new Date(),
} = {}) {
    const channel = resolveNbaChannel({
        storedAction: lead.next_action,
        decision,
        lead,
    });
    const percents = channelPercents(decision);
    const waitUntil = pickWaitUntil(lead, decision);
    const due = isDueAt(waitUntil, now);
    const held = isLeadOnHold(lead);
    const cadence = cadenceFromCounters(lead, decision, cadenceStep);
    const waitLine = held
        ? "On hold"
        : formatWaitUntil(waitUntil, decision.sendWindow?.timezone || lead.timezone || "Asia/Kolkata", now);
    const primary = primaryFor({ channel, due, operatingMode, pendingApproval, held });
    const heading = headingFor(channel);
    const rightWinner = channel === "REP_CALLBACK" ? "CALL" : channel;

    return {
        channel,
        heading,
        waitUntil: waitUntil ? waitUntil.toISOString() : null,
        waitLine,
        cadenceStep: cadence,
        subline: [waitLine, cadence].filter(Boolean).join(" · "),
        due: held ? false : due,
        held,
        primaryKind: primary.kind,
        primaryLabel: primary.label,
        rightWinner,
        percents,
        actionIsWait: channel === "WAIT",
        storedAction: upper(lead.next_action) || null,
        modelAction: upper(decision.action || decision.recommendedAction) || null,
    };
}

export function nbaNeverSaysWaitWhenModelSaysEmail(card) {
    const model = upper(card?.modelAction);
    if (model === "EMAIL" || (card?.percents?.hasData && card.percents.email >= card.percents.wait && card.percents.email >= card.percents.call && card.percents.email > 0)) {
        return card.channel === "EMAIL" && !/wait/i.test(card.heading || "");
    }
    return true;
}

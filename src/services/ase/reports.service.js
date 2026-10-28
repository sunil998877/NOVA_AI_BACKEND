import { COMPLIANCE_KINDS } from "./reports.constants.js";

export function pct(num, den) {
    const n = Number(num || 0);
    const d = Number(den || 0);
    if (!d) return 0;
    return Math.round((n / d) * 1000) / 10;
}

export function eventCount(rows, type, channel = null) {
    return (rows || [])
        .filter((row) => row.event_type === type && (channel == null || row.channel === channel))
        .reduce((sum, row) => sum + Number(row.c || row.total || 0), 0);
}

export function firstTouchMinutes(createdAt, firstTouchAt) {
    if (!createdAt || !firstTouchAt) return null;
    const start = new Date(createdAt).getTime();
    const end = new Date(firstTouchAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return Math.round(((end - start) / 60000) * 10) / 10;
}

export function averageFirstTouch(rows = []) {
    const minutes = rows
        .map((row) => firstTouchMinutes(row.created_at, row.first_at))
        .filter((value) => value != null);
    if (!minutes.length) return null;
    const avg = minutes.reduce((sum, value) => sum + value, 0) / minutes.length;
    return Math.round(avg * 10) / 10;
}

export function classifyComplianceKind(eventType, channel = "") {
    const type = String(eventType || "").toUpperCase();
    if (type === "CONSENT" || type.includes("CONSENT")) return COMPLIANCE_KINDS.CONSENT;
    if (type.includes("DNC") || type.includes("SUPPRESS") || type === "OUTREACH_HALTED") return COMPLIANCE_KINDS.DNC;
    if (type.includes("CAPACITY") || type.includes("CAP") || type.includes("FATIGUE")) return COMPLIANCE_KINDS.CAP;
    if (String(channel).toUpperCase() === "CONSENT") return COMPLIANCE_KINDS.CONSENT;
    return COMPLIANCE_KINDS.BLOCK;
}

export function reportOrEmpty(data, failed = false) {
    if (failed || data == null) return null;
    return data;
}

export function assembleReport({
    speedToLeadMinutes = null,
    contactedCount = 0,
    events = [],
    dials = 0,
    connected = 0,
    callbacks = {},
    interested = 0,
    meetings = 0,
} = {}) {
    const sent = eventCount(events, "EMAIL_SENT") + eventCount(events, "ActionDispatched", "EMAIL");
    const opened = eventCount(events, "EMAIL_OPENED");
    const replied = eventCount(events, "EMAIL_REPLY_RECEIVED");
    const callbacksQueued = eventCount(events, "CallbackCreated") + eventCount(events, "CALLBACK_CREATED");
    const completedCallbacks = Number(callbacks.completed || 0);
    const metCallbacks = Number(callbacks.met || 0);

    return {
        speedToLeadMinutes: speedToLeadMinutes == null ? null : Number(speedToLeadMinutes),
        contactedCount: Number(contactedCount || 0),
        email: {
            sent,
            opened,
            replied,
            interested: Number(interested || 0),
            meetings: Number(meetings || 0),
            responseRate: pct(opened + replied, sent),
            interestRate: pct(interested, sent),
        },
        voice: {
            dials: Number(dials || 0),
            connected: Number(connected || 0),
            callbacks: callbacksQueued,
            interested: Number(interested || 0),
            meetings: Number(meetings || 0),
            connectRate: pct(connected, dials),
            interestRate: pct(interested, dials),
        },
        callbacks: {
            total: Number(callbacks.total || 0),
            completed: completedCallbacks,
            met: metCallbacks,
            slaRate: pct(metCallbacks, completedCallbacks),
        },
        outcomes: {
            interested: Number(interested || 0),
            meetings: Number(meetings || 0),
        },
    };
}

export function reportToCsv(report = {}) {
    const rows = [
        ["metric", "value"],
        ["speed_to_lead_minutes", report.speedToLeadMinutes ?? ""],
        ["contacted_count", report.contactedCount ?? 0],
        ["email_sent", report.email?.sent ?? 0],
        ["email_opened", report.email?.opened ?? 0],
        ["email_replied", report.email?.replied ?? 0],
        ["email_interested", report.email?.interested ?? 0],
        ["email_meetings", report.email?.meetings ?? 0],
        ["email_response_rate", report.email?.responseRate ?? 0],
        ["voice_dials", report.voice?.dials ?? 0],
        ["voice_connected", report.voice?.connected ?? 0],
        ["voice_callbacks", report.voice?.callbacks ?? 0],
        ["voice_interested", report.voice?.interested ?? 0],
        ["voice_meetings", report.voice?.meetings ?? 0],
        ["voice_connect_rate", report.voice?.connectRate ?? 0],
        ["callback_total", report.callbacks?.total ?? 0],
        ["callback_completed", report.callbacks?.completed ?? 0],
        ["callback_sla_met", report.callbacks?.met ?? 0],
        ["callback_sla_rate", report.callbacks?.slaRate ?? 0],
        ["outcomes_interested", report.outcomes?.interested ?? 0],
        ["outcomes_meetings", report.outcomes?.meetings ?? 0],
    ];
    return rows.map((row) => row.join(",")).join("\n");
}

export function complianceToCsv(rows = []) {
    const header = ["kind", "created_at", "lead_id", "channel", "status", "reason"];
    const lines = [header.join(",")];
    for (const row of rows) {
        const values = [
            row.kind || classifyComplianceKind(row.event_type || row.status, row.channel),
            row.created_at ? new Date(row.created_at).toISOString() : "",
            row.lead_id ?? "",
            row.channel ?? "",
            row.status ?? row.event_type ?? "",
            String(row.reason || "").replace(/"/g, '""'),
        ];
        lines.push(values.map((value) => `"${value}"`).join(","));
    }
    return lines.join("\n");
}

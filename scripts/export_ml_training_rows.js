// Builds training_rows.jsonl from live leads + their events.
// Labels come from what actually happened (status, last channel, replies, clicks), not invented facts.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDb, query, closeDb } from "../src/config/db.js";

const TEST_ORGS = [9975, 9976, 9977];
const CONVERTED = new Set([
    "ENGAGED", "INTERESTED", "CALLBACK_SCHEDULED", "WARM_TRANSFER",
    "HANDED_OFF", "MEETING_BOOKED", "CLOSED_WON", "QUALIFIED",
]);
const WAIT_STATUSES = new Set([
    "SUPPRESSED_DNC", "CLOSED_LOST", "CLOSED_UNQUALIFIED", "NO_RESPONSE",
]);
const OPEN_EVENTS = /EMAIL_OPENED|EMAILOPENED|OPENED/i;
const CLICK_EVENTS = /CLICK|LINK_CLICK/i;
const REPLY_EVENTS = /REPLIED|REPLY_RECEIVED|EMAIL_REPLIED/i;
const EMAIL_SENT = /EMAIL_SENT|ActionCompleted/i;
const CALL_DONE = /CALL_|VOICE|ActionCompleted|ChannelOutcome/i;

function parseJson(value, fallback) {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function consentGranted(consent) {
    const value = parseJson(consent, null);
    return String(value?.status || "").toUpperCase() === "GRANTED" ? 1 : 0;
}

function hoursSince(date) {
    if (!date) return 999;
    const ms = Date.now() - new Date(date).getTime();
    if (!Number.isFinite(ms)) return 999;
    return Math.min(168, Math.max(0, ms / 3600000));
}

function teacherAction(raw) {
    const clicks = raw.link_clicks;
    const emailAtt = raw.email_attempts;
    const voiceAtt = raw.voice_attempts;
    const hours = raw.hours_since_last_touch;
    const emailOk = raw.email_consent;
    const voiceOk = raw.voice_consent;
    const highIntent = raw.high_intent;
    const touched = emailAtt + voiceAtt > 0;
    if (touched && hours < 18 && clicks === 0) return 2;
    if (emailAtt >= 3 && (voiceOk < 0.5 || voiceAtt >= 2)) return 2;
    if (emailOk < 0.5 && voiceOk < 0.5) return 2;
    if (clicks >= 1 && voiceOk >= 0.5 && voiceAtt < 2 && hours >= 12) return 1;
    if (highIntent >= 0.5 && voiceOk >= 0.5 && voiceAtt < 2 && emailAtt >= 1 && hours >= 20) return 1;
    if (emailAtt >= 2 && voiceOk >= 0.5 && voiceAtt < 2 && hours >= 24) return 1;
    if (emailOk >= 0.5 && emailAtt === 0) return 0;
    if (emailOk >= 0.5 && emailAtt < 3 && hours >= 36) return 0;
    if (voiceOk >= 0.5 && voiceAtt < 2 && hours >= 24) return 1;
    if (emailOk >= 0.5) return 0;
    return 2;
}

function delayHours(raw, action, lead) {
    if (lead.next_action_time && lead.last_contacted_at) {
        const gap = (new Date(lead.next_action_time) - new Date(lead.last_contacted_at)) / 3600000;
        if (Number.isFinite(gap) && gap >= 0 && gap <= 168) return Math.round(gap * 10) / 10;
    }
    if (action === 2) return Math.min(48, Math.max(4, 24 - Math.min(raw.hours_since_last_touch, 24)));
    if (action === 1) return raw.link_clicks >= 1 ? 0 : (raw.hours_since_last_touch >= 48 ? 2 : 8);
    if (raw.email_attempts === 0 || raw.hours_since_last_touch >= 48) return 0;
    if (raw.link_clicks >= 1) return 1;
    return 24;
}

function labelAction(lead, raw, stats) {
    const status = String(lead.status || "").toUpperCase();
    if (lead.do_not_contact || WAIT_STATUSES.has(status)) return 2;
    if (stats.replies > 0) return 0;
    if (CONVERTED.has(status) && raw.voice_consent >= 0.5 && raw.voice_attempts > 0) return 1;
    if (CONVERTED.has(status) && raw.email_consent >= 0.5) return 0;
    if (raw.link_clicks >= 1 && raw.voice_consent >= 0.5 && raw.voice_attempts < 2) return 1;
    if (stats.lastChannel === "VOICE" || stats.lastChannel === "CALL") return raw.voice_consent >= 0.5 ? 1 : 2;
    if (stats.lastChannel === "EMAIL" && raw.email_opens === 0 && raw.email_attempts >= 2 && raw.voice_consent >= 0.5) return 1;
    if (stats.lastChannel === "EMAIL") return raw.email_consent >= 0.5 ? 0 : 2;
    return teacherAction(raw);
}

async function main() {
    await connectDb();
    const leads = await query(
        `SELECT id, organization_id, status, priority, last_contacted_at, next_action_time, next_action,
                attempt_counters, email_consent, voice_consent, do_not_contact, metadata, created_at
         FROM leads
         WHERE organization_id NOT IN (${TEST_ORGS.join(",")})
         ORDER BY id ASC
         LIMIT 5000`
    );
    const events = leads.length
        ? await query(
            `SELECT lead_id, channel, event_type, status, created_at
             FROM lead_events
             WHERE organization_id NOT IN (${TEST_ORGS.join(",")})
             ORDER BY created_at ASC
             LIMIT 40000`
        )
        : [];

    const byLead = new Map();
    for (const ev of events) {
        const id = Number(ev.lead_id);
        const row = byLead.get(id) || { opens: 0, clicks: 0, replies: 0, emails: 0, calls: 0, lastChannel: null };
        const type = String(ev.event_type || "");
        const channel = String(ev.channel || "").toUpperCase();
        if (OPEN_EVENTS.test(type)) row.opens += 1;
        if (CLICK_EVENTS.test(type)) row.clicks += 1;
        if (REPLY_EVENTS.test(type)) row.replies += 1;
        if (channel === "EMAIL" && EMAIL_SENT.test(type)) row.emails += 1;
        if ((channel === "VOICE" || channel === "CALL") && CALL_DONE.test(type)) row.calls += 1;
        if (channel === "EMAIL" || channel === "VOICE" || channel === "CALL") row.lastChannel = channel === "CALL" ? "VOICE" : channel;
        byLead.set(id, row);
    }

    const rows = [];
    const counts = { EMAIL: 0, CALL: 0, WAIT: 0, converted: 0 };
    for (const lead of leads) {
        const counters = parseJson(lead.attempt_counters, { email: 0, voice: 0 });
        const meta = parseJson(lead.metadata, {});
        const stats = byLead.get(Number(lead.id)) || { opens: 0, clicks: 0, replies: 0, emails: 0, calls: 0, lastChannel: null };
        const emailAttempts = Number(counters.email || stats.emails || 0);
        const voiceAttempts = Number(counters.voice || stats.calls || 0);
        const emailOpens = Number(meta.email_opens || meta.opens_count || stats.opens || 0);
        const linkClicks = Number(meta.link_clicks || meta.clicks_count || stats.clicks || 0);
        const hours = hoursSince(lead.last_contacted_at || lead.created_at);
        const status = String(lead.status || "").toUpperCase();
        const highIntent = CONVERTED.has(status) || linkClicks >= 2 || stats.replies > 0 ? 1 : 0;
        const raw = {
            email_opens: emailOpens,
            link_clicks: linkClicks,
            email_attempts: emailAttempts,
            voice_attempts: voiceAttempts,
            hours_since_last_touch: Number(hours.toFixed(1)),
            engagement_score: Math.min(100, emailOpens * 8 + linkClicks * 35 + (highIntent ? 20 : 0)),
            email_consent: consentGranted(lead.email_consent),
            voice_consent: consentGranted(lead.voice_consent),
            priority: Number(lead.priority || 50),
            high_intent: highIntent,
            recent_click: linkClicks > 0 && hours <= 48 ? 1 : 0,
            fatigue: Math.min(1, (emailAttempts / 3) * 0.6 + (voiceAttempts / 2) * 0.4),
            status,
        };
        const action = labelAction(lead, raw, stats);
        const converted = CONVERTED.has(status) || stats.replies > 0 || linkClicks >= 1 || emailOpens >= 2 ? 1 : 0;
        const delay = delayHours(raw, action, lead);
        rows.push({ ...raw, action, delay_hours: delay, converted, lead_id: Number(lead.id) });
        counts[["EMAIL", "CALL", "WAIT"][action]] += 1;
        counts.converted += converted;
    }

    const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "models", "ml");
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, "training_rows.jsonl");
    writeFileSync(outPath, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
    console.log(JSON.stringify({
        status: "EXPORTED",
        leads: leads.length,
        events: events.length,
        rows: rows.length,
        labels: { EMAIL: counts.EMAIL, CALL: counts.CALL, WAIT: counts.WAIT, converted: counts.converted },
        path: outPath,
    }));
    await closeDb();
}

main().catch(async (err) => {
    console.error("EXPORT_FAILED", err.message);
    await closeDb().catch(() => {});
    process.exit(1);
});

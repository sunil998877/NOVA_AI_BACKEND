import { test } from "node:test";
import assert from "node:assert/strict";
import {
    COMPLIANCE_EVENT_TYPES,
    COMPLIANCE_KINDS,
    FIRST_TOUCH_EVENTS,
    INTEREST_STATUSES,
    MEETING_STATUSES,
} from "../services/ase/reports.constants.js";
import {
    assembleReport,
    averageFirstTouch,
    classifyComplianceKind,
    complianceToCsv,
    firstTouchMinutes,
    reportOrEmpty,
    reportToCsv,
} from "../services/ase/reports.service.js";
import { LIVE_SEGMENTS, filtersToQuery, findSegment } from "../services/ase/segment.constants.js";
import { buildLeadWhere } from "../models/lead.model.js";

test("speed-to-lead uses first EMAIL_SENT, not last_contacted_at", () => {
    const created = "2026-10-01T10:00:00.000Z";
    const firstEmail = "2026-10-01T10:12:00.000Z";
    const lastContacted = "2026-10-04T10:00:00.000Z";
    assert.equal(firstTouchMinutes(created, firstEmail), 12);
    assert.ok(firstTouchMinutes(created, lastContacted) > 1000);
    assert.equal(
        averageFirstTouch([{ created_at: created, first_at: firstEmail, last_contacted_at: lastContacted }]),
        12
    );
    assert.ok(FIRST_TOUCH_EVENTS.includes("EMAIL_SENT"));
    assert.ok(FIRST_TOUCH_EVENTS.includes("CALL_INITIATED"));
    assert.equal(FIRST_TOUCH_EVENTS.includes("last_contacted_at"), false);
});

test("channel report includes interested and meetings, not only sent/open/reply", () => {
    const report = assembleReport({
        events: [
            { event_type: "EMAIL_SENT", c: 10 },
            { event_type: "EMAIL_OPENED", c: 4 },
            { event_type: "EMAIL_REPLY_RECEIVED", c: 1 },
        ],
        interested: 3,
        meetings: 1,
        dials: 8,
        connected: 2,
    });
    assert.equal(report.email.sent, 10);
    assert.equal(report.email.opened, 4);
    assert.equal(report.email.replied, 1);
    assert.equal(report.email.interested, 3);
    assert.equal(report.email.meetings, 1);
    assert.equal(report.voice.interested, 3);
    assert.equal(report.outcomes.meetings, 1);
    assert.ok(INTEREST_STATUSES.includes("INTERESTED"));
    assert.ok(MEETING_STATUSES.includes("CLOSED_WON"));
    const csv = reportToCsv(report);
    assert.match(csv, /email_interested,3/);
    assert.match(csv, /outcomes_meetings,1/);
});

test("failed report payload is empty, not dummy zeros", () => {
    assert.equal(reportOrEmpty({ speedToLeadMinutes: 0, email: { sent: 42 } }, true), null);
    assert.equal(reportOrEmpty(null, false), null);
    const live = reportOrEmpty({ speedToLeadMinutes: 0 }, false);
    assert.equal(live.speedToLeadMinutes, 0);
});

test("compliance csv covers consent, DNC, and cap breach", () => {
    assert.equal(classifyComplianceKind("CONSENT", "EMAIL"), COMPLIANCE_KINDS.CONSENT);
    assert.equal(classifyComplianceKind("OUTREACH_HALTED", "VOICE"), COMPLIANCE_KINDS.DNC);
    assert.equal(classifyComplianceKind("CAPACITY_DEFERRED", "VOICE"), COMPLIANCE_KINDS.CAP);
    assert.ok(COMPLIANCE_EVENT_TYPES.includes("CAPACITY_DEFERRED"));
    const csv = complianceToCsv([
        { kind: "CONSENT", created_at: "2026-10-01T00:00:00.000Z", lead_id: 1, channel: "EMAIL", status: "GRANTED", reason: "import" },
        { kind: "DNC", created_at: "2026-10-02T00:00:00.000Z", lead_id: 2, channel: "VOICE", status: "OUTREACH_HALTED", reason: "dnc" },
        { kind: "CAP", created_at: "2026-10-03T00:00:00.000Z", lead_id: 3, channel: "VOICE", status: "CAPACITY_DEFERRED", reason: "cap" },
    ]);
    assert.match(csv, /CONSENT/);
    assert.match(csv, /DNC/);
    assert.match(csv, /CAP/);
});

test("live segments are real filters, not random counts", () => {
    assert.ok(LIVE_SEGMENTS.length >= 5);
    for (const segment of LIVE_SEGMENTS) {
        assert.ok(segment.filters && Object.keys(segment.filters).length);
        assert.equal(typeof segment.leadCount, "undefined");
    }
    assert.equal(findSegment("hot_callbacks").filters.status, "CALLBACK_SCHEDULED");
    assert.equal(filtersToQuery({ minPriority: 80 }).min_priority, 80);
    assert.equal(filtersToQuery({ emailConsent: "GRANTED" }).email_consent, "GRANTED");
    const { whereSql, params } = buildLeadWhere(7, { health: "RED", minPriority: 80, emailConsent: "GRANTED" });
    assert.match(whereSql, /health/);
    assert.match(whereSql, /priority >=/);
    assert.match(whereSql, /email_consent/);
    assert.equal(params[0], 7);
    assert.ok(params.includes("RED"));
    assert.ok(params.includes(80));
    assert.ok(params.includes("GRANTED"));
});

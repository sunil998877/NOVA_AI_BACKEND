import { test } from "node:test";
import assert from "node:assert/strict";
import { FIRST_TOUCH_EVENTS } from "../services/ase/reports.constants.js";
import {
    assembleReport,
    averageFirstTouch,
    firstTouchMinutes,
    reportOrEmpty,
    reportToCsv,
} from "../services/ase/reports.service.js";
import { LIVE_SEGMENTS, filtersToQuery } from "../services/ase/segment.constants.js";

test("feature: speed-to-lead is created_at to first EMAIL_SENT or CALL, never last_contacted_at", () => {
    const created = "2026-10-27T08:00:00.000Z";
    const firstCall = "2026-10-27T08:04:00.000Z";
    const lastContacted = "2026-10-27T18:00:00.000Z";
    assert.equal(firstTouchMinutes(created, firstCall), 4);
    assert.notEqual(firstTouchMinutes(created, lastContacted), 4);
    assert.equal(averageFirstTouch([{ created_at: created, first_at: firstCall, last_contacted_at: lastContacted }]), 4);
    assert.ok(FIRST_TOUCH_EVENTS.includes("EMAIL_SENT"));
    assert.ok(FIRST_TOUCH_EVENTS.includes("CALL_INITIATED"));
});

test("feature: reports expose interested/meeting and fail empty instead of dummy zeros", () => {
    const report = assembleReport({ interested: 2, meetings: 1, events: [{ event_type: "EMAIL_SENT", c: 5 }] });
    assert.equal(report.email.interested, 2);
    assert.equal(report.outcomes.meetings, 1);
    assert.match(reportToCsv(report), /email_interested,2/);
    assert.equal(reportOrEmpty({ email: { sent: 99 } }, true), null);
});

test("feature: segments page is backed by live filters not hardcoded dummy counts", () => {
    const high = LIVE_SEGMENTS.find((segment) => segment.id === "high_priority");
    assert.equal(high.filters.minPriority, 80);
    assert.equal(filtersToQuery(high.filters).min_priority, 80);
    assert.equal(LIVE_SEGMENTS.some((segment) => segment.leadCount === 42), false);
});

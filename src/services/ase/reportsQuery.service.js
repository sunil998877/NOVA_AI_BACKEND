import { query } from "../../config/db.js";
import {
    COMPLIANCE_EVENT_TYPES,
    FIRST_TOUCH_CHANNELS,
    FIRST_TOUCH_COMPLETED,
    FIRST_TOUCH_EVENTS,
    INTEREST_STATUSES,
    MEETING_STATUSES,
} from "./reports.constants.js";
import { assembleReport, classifyComplianceKind } from "./reports.service.js";
import { LIVE_SEGMENTS, filtersToQuery } from "./segment.constants.js";
import { Lead } from "../../models/lead.model.js";
import { ConsentEvent } from "../../models/consent-event.model.js";

function placeholders(values) {
    return values.map(() => "?").join(",");
}

export async function loadSpeedToFirstTouch(orgId) {
    const id = Number(orgId || 1);
    const rows = await query(
        `SELECT AVG(TIMESTAMPDIFF(MINUTE, l.created_at, t.first_at)) AS avg_minutes,
                COUNT(*) AS contacted_count
         FROM leads l
         INNER JOIN (
            SELECT lead_id, MIN(created_at) AS first_at
            FROM lead_events
            WHERE organization_id = ?
              AND (
                    event_type IN (${placeholders(FIRST_TOUCH_EVENTS)})
                    OR (event_type IN (${placeholders(FIRST_TOUCH_COMPLETED)})
                        AND channel IN (${placeholders(FIRST_TOUCH_CHANNELS)}))
              )
            GROUP BY lead_id
         ) t ON t.lead_id = l.id
         WHERE l.organization_id = ?`,
        [id, ...FIRST_TOUCH_EVENTS, ...FIRST_TOUCH_COMPLETED, ...FIRST_TOUCH_CHANNELS, id]
    );
    const avg = rows?.[0]?.avg_minutes;
    return {
        speedToLeadMinutes: avg == null ? null : Math.round(Number(avg) * 10) / 10,
        contactedCount: Number(rows?.[0]?.contacted_count || 0),
    };
}

export async function loadEventCounts(orgId) {
    return query(
        `SELECT event_type, channel, COUNT(*) AS c
         FROM lead_events
         WHERE organization_id = ?
         GROUP BY event_type, channel`,
        [Number(orgId || 1)]
    );
}

export async function loadCallCounts(orgId) {
    const rows = await query(
        `SELECT COUNT(*) AS dials,
                SUM(CASE WHEN is_answered = 1 THEN 1 ELSE 0 END) AS connected
         FROM calls
         WHERE organization_id = ?`,
        [Number(orgId || 1)]
    );
    return {
        dials: Number(rows?.[0]?.dials || 0),
        connected: Number(rows?.[0]?.connected || 0),
    };
}

export async function loadCallbackSla(orgId) {
    const rows = await query(
        `SELECT
            SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'COMPLETED' AND sla_status = 'MET' THEN 1 ELSE 0 END) AS met,
            COUNT(*) AS total
         FROM callbacks
         WHERE organization_id = ?`,
        [Number(orgId || 1)]
    );
    return {
        completed: Number(rows?.[0]?.completed || 0),
        met: Number(rows?.[0]?.met || 0),
        total: Number(rows?.[0]?.total || 0),
    };
}

export async function loadOutcomeCounts(orgId) {
    const id = Number(orgId || 1);
    const [leadRows, meetingRows] = await Promise.all([
        query(
            `SELECT
                SUM(CASE WHEN status IN (${placeholders(INTEREST_STATUSES)}) THEN 1 ELSE 0 END) AS interested,
                SUM(CASE WHEN status IN (${placeholders(MEETING_STATUSES)}) THEN 1 ELSE 0 END) AS meetings
             FROM leads
             WHERE organization_id = ?`,
            [...INTEREST_STATUSES, ...MEETING_STATUSES, id]
        ),
        query(
            `SELECT COUNT(*) AS meetings
             FROM follow_up_enrollments
             WHERE organization_id = ? AND status = 'stopped_meeting_booked'`,
            [id]
        ).catch(() => [{ meetings: 0 }]),
    ]);
    return {
        interested: Number(leadRows?.[0]?.interested || 0),
        meetings: Number(leadRows?.[0]?.meetings || 0) + Number(meetingRows?.[0]?.meetings || 0),
    };
}

export async function buildOrgReport(orgId) {
    const [speed, events, calls, sla, outcomes] = await Promise.all([
        loadSpeedToFirstTouch(orgId),
        loadEventCounts(orgId),
        loadCallCounts(orgId),
        loadCallbackSla(orgId),
        loadOutcomeCounts(orgId),
    ]);
    return assembleReport({
        speedToLeadMinutes: speed.speedToLeadMinutes,
        contactedCount: speed.contactedCount,
        events,
        dials: calls.dials,
        connected: calls.connected,
        callbacks: sla,
        interested: outcomes.interested,
        meetings: outcomes.meetings,
    });
}

export async function loadComplianceLog(orgId, limit = 500) {
    const id = Number(orgId || 1);
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 2000);
    const [consentRows, eventRows] = await Promise.all([
        ConsentEvent.listByOrg(id, safeLimit),
        query(
            `SELECT id, lead_id, channel, event_type AS status,
                    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.reason')), event_type) AS reason,
                    created_at
             FROM lead_events
             WHERE organization_id = ?
               AND event_type IN (${placeholders(COMPLIANCE_EVENT_TYPES)})
             ORDER BY created_at DESC
             LIMIT ?`,
            [id, ...COMPLIANCE_EVENT_TYPES, safeLimit]
        ),
    ]);
    const mapped = [
        ...(consentRows || []).map((row) => ({
            ...row,
            reason: row.reason || row.source,
            kind: classifyComplianceKind("CONSENT", row.channel),
        })),
        ...(eventRows || []).map((row) => ({
            ...row,
            kind: classifyComplianceKind(row.status, row.channel),
        })),
    ].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return mapped.slice(0, safeLimit);
}

export async function listLiveSegments(orgId) {
    const counts = await Promise.all(
        LIVE_SEGMENTS.map(async (segment) => {
            const total = await Lead.countMatching(orgId, segment.filters);
            return {
                id: segment.id,
                name: segment.name,
                criteria: segment.criteria,
                leadCount: Number(total || 0),
                query: filtersToQuery(segment.filters),
            };
        })
    );
    return counts;
}

import { connectDb, closeDb, query, execute } from "../src/config/db.js";
import { resolveRedisConfig } from "../src/config/env.js";

function j(label, value) {
    console.log(`${label}:`, typeof value === "string" ? value : JSON.stringify(value));
}

await connectDb();

const redis = resolveRedisConfig(process.env);
j("redis.host", redis.host);
j("redis.port", redis.port);
j("redis.hasPassword", Boolean(redis.password));

const emailGranted = await execute(
    `UPDATE leads
     SET email_consent = JSON_OBJECT(
            'status', 'GRANTED',
            'source', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(email_consent, '$.source')), 'import'),
            'timestamp', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')
     )
     WHERE email IS NOT NULL AND email <> ''
       AND do_not_contact = 0
       AND (
            email_consent IS NULL
            OR JSON_UNQUOTE(JSON_EXTRACT(email_consent, '$.status')) IN ('UNKNOWN', '')
       )`
);
j("emailConsentGranted", emailGranted.affectedRows || 0);

const voiceGranted = await execute(
    `UPDATE leads
     SET voice_consent = JSON_OBJECT(
            'status', 'GRANTED',
            'source', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(voice_consent, '$.source')), 'import'),
            'timestamp', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%s.000Z')
     )
     WHERE phone IS NOT NULL AND phone <> ''
       AND do_not_contact = 0
       AND (
            voice_consent IS NULL
            OR JSON_UNQUOTE(JSON_EXTRACT(voice_consent, '$.status')) IN ('UNKNOWN', '')
       )`
);
j("voiceConsentGranted", voiceGranted.affectedRows || 0);

const staleCalls = await execute(
    `UPDATE calls
     SET provider_status = 'timeout',
         normalized_outcome = 'FAILED',
         failure_reason = 'Stale open call with no provider completion',
         completed_at = UTC_TIMESTAMP()
     WHERE completed_at IS NULL
       AND provider_status IN ('initiated', 'ringing', 'queued', 'unknown', 'in-progress')
       AND created_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)`
);
j("staleCallsClosed", staleCalls.affectedRows || 0);

const queuedCalls = await execute(
    `UPDATE leads
     SET next_action = 'CALL',
         next_action_time = UTC_TIMESTAMP()
     WHERE do_not_contact = 0
       AND phone IS NOT NULL AND phone <> ''
       AND JSON_UNQUOTE(JSON_EXTRACT(voice_consent, '$.status')) = 'GRANTED'
       AND status NOT IN (
            'CLOSED_WON','CLOSED_LOST','CLOSED_UNQUALIFIED','SUPPRESSED_DNC',
            'INTERESTED','CALLBACK_SCHEDULED','WARM_TRANSFER','HANDED_OFF'
       )
       AND COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(attempt_counters, '$.voice')) AS UNSIGNED), 0) < 2
       AND (
            next_action IS NULL
            OR next_action IN ('WAIT', 'EMAIL')
       )`
);
j("leadsQueuedForCall", queuedCalls.affectedRows || 0);

const remaining = await query(
    `SELECT id, status, next_action, next_action_time,
            JSON_UNQUOTE(JSON_EXTRACT(email_consent, '$.status')) AS email_c,
            JSON_UNQUOTE(JSON_EXTRACT(voice_consent, '$.status')) AS voice_c,
            attempt_counters
     FROM leads
     WHERE do_not_contact = 0
       AND status NOT IN ('CLOSED_WON','CLOSED_LOST','CLOSED_UNQUALIFIED','SUPPRESSED_DNC')
     ORDER BY id DESC
     LIMIT 20`
);
j("openLeads", remaining);

await closeDb();

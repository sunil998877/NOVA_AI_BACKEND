export const HANDOFF_STATUSES = Object.freeze({
    INTERESTED: "INTERESTED",
    HANDOFF_REQUESTED: "HANDOFF_REQUESTED",
    CALLBACK_PENDING: "CALLBACK_PENDING",
    MEETING_REQUESTED: "MEETING_REQUESTED",
    MEETING_PENDING: "MEETING_PENDING",
    MEETING_BOOKED: "MEETING_BOOKED",
    BOOKING_FAILED: "BOOKING_FAILED",
    MEETING_CANCELLED: "MEETING_CANCELLED",
});

export const MEETING_STATUSES = Object.freeze({
    MEETING_REQUESTED: "MEETING_REQUESTED",
    MEETING_PENDING: "MEETING_PENDING",
    MEETING_BOOKED: "MEETING_BOOKED",
    BOOKING_FAILED: "BOOKING_FAILED",
    MEETING_CANCELLED: "MEETING_CANCELLED",
});

export const OPEN_MEETING_STATUSES = Object.freeze([
    MEETING_STATUSES.MEETING_REQUESTED,
    MEETING_STATUSES.MEETING_PENDING,
    MEETING_STATUSES.MEETING_BOOKED,
    MEETING_STATUSES.BOOKING_FAILED,
]);

export const salesMeetingSchema = {
    table: "sales_meetings",
    columns:
        "id, organization_id, lead_id, rep_user_id, source, source_ref, status, title, preferred_text, preferred_start, timezone, duration_minutes, start_at, end_at, calendar_provider, calendar_id, calendar_event_id, calendar_event_link, confirmation, booking_revision, booking_claimed_at, attempts, last_error, booked_at, cancelled_at, cancel_reason, created_by, created_at, updated_at",
    createTable: `CREATE TABLE IF NOT EXISTS sales_meetings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        lead_id INT NOT NULL,
        rep_user_id INT NULL,
        source VARCHAR(16) NOT NULL DEFAULT 'MANUAL',
        source_ref VARCHAR(128) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'MEETING_REQUESTED',
        title VARCHAR(255) NULL,
        preferred_text VARCHAR(500) NULL,
        preferred_start DATETIME NULL,
        timezone VARCHAR(64) NULL,
        duration_minutes INT NOT NULL DEFAULT 30,
        start_at DATETIME NULL,
        end_at DATETIME NULL,
        calendar_provider VARCHAR(32) NULL,
        calendar_id VARCHAR(255) NULL,
        calendar_event_id VARCHAR(255) NULL,
        calendar_event_link VARCHAR(1000) NULL,
        confirmation JSON NULL,
        booking_revision INT NOT NULL DEFAULT 0,
        booking_claimed_at DATETIME NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_error VARCHAR(1000) NULL,
        booked_at DATETIME NULL,
        cancelled_at DATETIME NULL,
        cancel_reason VARCHAR(500) NULL,
        created_by INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        open_slot TINYINT GENERATED ALWAYS AS (CASE WHEN status IN ('MEETING_REQUESTED', 'MEETING_PENDING', 'MEETING_BOOKED', 'BOOKING_FAILED') THEN 1 ELSE NULL END) STORED,
        UNIQUE KEY uq_meeting_open_per_lead (organization_id, lead_id, open_slot),
        UNIQUE KEY uq_meeting_calendar_event (calendar_provider, calendar_event_id),
        INDEX idx_meeting_org_status (organization_id, status, preferred_start),
        INDEX idx_meeting_rep (organization_id, rep_user_id, start_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

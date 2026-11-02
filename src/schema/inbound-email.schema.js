export const REPLY_INTENTS = Object.freeze({
    INTERESTED: "INTERESTED",
    PRICING_QUERY: "PRICING_QUERY",
    PRODUCT_QUESTION: "PRODUCT_QUESTION",
    CALLBACK_REQUEST: "CALLBACK_REQUEST",
    MEETING_REQUEST: "MEETING_REQUEST",
    NOT_INTERESTED: "NOT_INTERESTED",
    OPT_OUT: "OPT_OUT",
    COMPLAINT: "COMPLAINT",
    OTHER: "OTHER",
});

export const REPLY_ROUTES = Object.freeze({
    AI_DRAFT: "AI_DRAFT",
    HUMAN_REVIEW: "HUMAN_REVIEW",
    SUPPRESS: "SUPPRESS",
    NO_REPLY: "NO_REPLY",
});

export const REPLY_DRAFT_STATUSES = Object.freeze({
    PENDING_APPROVAL: "PENDING_APPROVAL",
    NEEDS_HUMAN_REVIEW: "NEEDS_HUMAN_REVIEW",
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    SENDING: "SENDING",
    SENT: "SENT",
    SEND_FAILED: "SEND_FAILED",
    SEND_UNKNOWN: "SEND_UNKNOWN",
    CANCELLED: "CANCELLED",
});

export const inboundEmailSchema = {
    table: "inbound_emails",
    columns:
        "id, organization_id, lead_id, enrollment_id, campaign_id, message_id, in_reply_to, references_json, from_email, to_email, subject, body_text, received_at, matched_by, intent, intent_confidence, intent_method, route, review_flags, status, created_at, updated_at",
    createTable: `CREATE TABLE IF NOT EXISTS inbound_emails (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        lead_id INT NOT NULL,
        enrollment_id INT NULL,
        campaign_id INT NULL,
        message_id VARCHAR(255) NOT NULL,
        in_reply_to VARCHAR(255) NULL,
        references_json JSON NULL,
        from_email VARCHAR(255) NOT NULL,
        to_email VARCHAR(255) NULL,
        subject VARCHAR(500) NULL,
        body_text MEDIUMTEXT NULL,
        received_at DATETIME NOT NULL,
        matched_by VARCHAR(64) NULL,
        intent VARCHAR(32) NOT NULL DEFAULT 'OTHER',
        intent_confidence DECIMAL(4,3) NULL,
        intent_method VARCHAR(32) NULL,
        route VARCHAR(32) NOT NULL DEFAULT 'HUMAN_REVIEW',
        review_flags JSON NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'RECEIVED',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_inbound_org_message (organization_id, message_id),
        INDEX idx_inbound_lead (organization_id, lead_id, received_at),
        INDEX idx_inbound_intent (organization_id, intent)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

export const emailReplyDraftSchema = {
    table: "email_reply_drafts",
    columns:
        "id, organization_id, lead_id, inbound_email_id, intent, status, subject, body_text, body_html, generated_subject, generated_body_text, generation_method, grounding, guard_issues, review_reason, edited, edited_by, edited_at, reviewed_by, reviewed_at, reject_reason, send_attempts, sent_message_id, sent_at, send_error, created_at, updated_at",
    createTable: `CREATE TABLE IF NOT EXISTS email_reply_drafts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        lead_id INT NOT NULL,
        inbound_email_id INT NOT NULL,
        intent VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'PENDING_APPROVAL',
        subject VARCHAR(500) NULL,
        body_text MEDIUMTEXT NULL,
        body_html MEDIUMTEXT NULL,
        generated_subject VARCHAR(500) NULL,
        generated_body_text MEDIUMTEXT NULL,
        generation_method VARCHAR(32) NULL,
        grounding JSON NULL,
        guard_issues JSON NULL,
        review_reason VARCHAR(500) NULL,
        edited TINYINT(1) NOT NULL DEFAULT 0,
        edited_by INT NULL,
        edited_at DATETIME NULL,
        reviewed_by INT NULL,
        reviewed_at DATETIME NULL,
        reject_reason VARCHAR(500) NULL,
        send_attempts INT NOT NULL DEFAULT 0,
        sent_message_id VARCHAR(255) NULL,
        sent_at DATETIME NULL,
        send_error VARCHAR(1000) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_reply_draft_inbound (organization_id, inbound_email_id),
        INDEX idx_reply_draft_status (organization_id, status, created_at),
        INDEX idx_reply_draft_lead (organization_id, lead_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

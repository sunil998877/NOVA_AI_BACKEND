export const telephonyWebhookEventSchema = {
    table: "telephony_webhook_events",
    columns:
        "id, organization_id, provider, event_id, event_fingerprint, provider_call_uuid, call_id, event_type, payload, created_at",
    updatable: ["call_id", "payload"],
    createTable: `CREATE TABLE IF NOT EXISTS telephony_webhook_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL DEFAULT 1,
        provider VARCHAR(32) NOT NULL DEFAULT 'plivo',
        event_id VARCHAR(128) NULL,
        event_fingerprint VARCHAR(191) NOT NULL,
        provider_call_uuid VARCHAR(128) NULL,
        call_id INT NULL,
        event_type VARCHAR(64) NOT NULL,
        payload JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_twe_fingerprint (event_fingerprint),
        INDEX idx_twe_uuid (provider_call_uuid),
        INDEX idx_twe_call (call_id),
        INDEX idx_twe_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

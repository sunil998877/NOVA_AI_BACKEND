export const leadEventSchema = {
    table: "lead_events",
    columns:
        "id, organization_id, lead_id, user_id, channel, event_type, status, payload, idempotency_key, created_at",
    createTable: `CREATE TABLE IF NOT EXISTS lead_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        lead_id INT NOT NULL,
        user_id INT NULL,
        channel VARCHAR(32) NOT NULL DEFAULT 'SYSTEM',
        event_type VARCHAR(64) NOT NULL,
        status VARCHAR(32) NULL,
        payload JSON NULL,
        idempotency_key VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_le_org_lead (organization_id, lead_id),
        INDEX idx_le_event (event_type),
        INDEX idx_le_channel (channel),
        INDEX idx_le_created (created_at),
        INDEX idx_le_idempotency (organization_id, idempotency_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

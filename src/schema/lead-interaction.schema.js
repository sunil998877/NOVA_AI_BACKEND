export const leadInteractionSchema = {
    table: "lead_interactions",
    columns:
        "id, lead_id, user_id, channel, direction, event_type, status, payload, created_at",
    createTable: `CREATE TABLE IF NOT EXISTS lead_interactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        lead_id INT NOT NULL,
        user_id INT NOT NULL,
        channel VARCHAR(32) NOT NULL,
        direction VARCHAR(16) NOT NULL DEFAULT 'outbound',
        event_type VARCHAR(64) NOT NULL,
        status VARCHAR(32) NULL,
        payload TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_li_lead (lead_id),
        INDEX idx_li_user (user_id),
        INDEX idx_li_channel (channel),
        INDEX idx_li_event (event_type),
        INDEX idx_li_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

export const consentEventSchema = {
    table: "consent_events",
    columns:
        "id, organization_id, lead_id, channel, status, source, actor_user_id, created_at",
    createTable: `CREATE TABLE IF NOT EXISTS consent_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        lead_id INT NOT NULL,
        channel VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL,
        source VARCHAR(32) NOT NULL,
        actor_user_id INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_consent_org_lead (organization_id, lead_id),
        INDEX idx_consent_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

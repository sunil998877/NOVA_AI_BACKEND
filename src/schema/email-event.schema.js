export const emailEventSchema = {
    table: "email_events",
    columns:
        "id, campaignId, recipientId, eventType, url, timestamp, userAgent, ipAddress",
    updatable: [],
    createTable: `CREATE TABLE IF NOT EXISTS email_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        campaignId INT NOT NULL,
        recipientId INT NOT NULL,
        eventType ENUM('open', 'click') NOT NULL,
        url TEXT NULL,
        timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        userAgent TEXT NULL,
        ipAddress VARCHAR(64) NULL,
        INDEX idx_ee_campaign (campaignId),
        INDEX idx_ee_recipient (recipientId),
        INDEX idx_ee_type (eventType),
        INDEX idx_ee_campaign_type (campaignId, eventType),
        INDEX idx_ee_recipient_type (recipientId, eventType),
        CONSTRAINT fk_ee_campaign FOREIGN KEY (campaignId) REFERENCES campaigns(id) ON DELETE CASCADE,
        CONSTRAINT fk_ee_recipient FOREIGN KEY (recipientId) REFERENCES mails(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

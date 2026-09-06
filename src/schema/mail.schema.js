export const mailSchema = {
    table: "mails",
    columns:
        "id, campaign_id, user_id, email, full_name, status, delivery_status, open_count, sent_at, createdAt, updatedAt",
    updatable: ["status", "delivery_status", "open_count", "sent_at", "full_name", "email"],
    createTable: `CREATE TABLE IF NOT EXISTS mails (
        id INT AUTO_INCREMENT PRIMARY KEY,
        campaign_id INT NOT NULL,
        user_id INT NOT NULL,
        email VARCHAR(255) NULL,
        full_name VARCHAR(255) NULL,
        status TINYINT(1) NOT NULL DEFAULT 0,
        delivery_status VARCHAR(32) NOT NULL DEFAULT 'pending',
        open_count INT NOT NULL DEFAULT 0,
        sent_at DATETIME NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_mails_campaign (campaign_id),
        INDEX idx_mails_user (user_id),
        CONSTRAINT fk_mails_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
        CONSTRAINT fk_mails_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

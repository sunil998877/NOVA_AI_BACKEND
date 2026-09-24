export const emailTrackingLinkSchema = {
    table: "email_tracking_links",
    columns:
        "id, mail_id, campaign_id, lead_id, tracking_token, original_url, link_type, created_at",
    updatable: [],
    createTable: `CREATE TABLE IF NOT EXISTS email_tracking_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        mail_id INT NOT NULL,
        campaign_id INT NULL,
        lead_id INT NULL,
        tracking_token VARCHAR(64) NOT NULL,
        original_url TEXT NULL,
        link_type ENUM('open', 'click') NOT NULL DEFAULT 'click',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_etl_token (tracking_token),
        INDEX idx_etl_mail (mail_id),
        INDEX idx_etl_campaign (campaign_id),
        INDEX idx_etl_type (link_type),
        CONSTRAINT fk_etl_mail FOREIGN KEY (mail_id) REFERENCES mails(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

export const campaignRecipientSchema = {
    table: "campaign_recipients",
    columns: "id, campaign_id, contact_id, status, sent_at, created_at",
    createTable: `CREATE TABLE IF NOT EXISTS campaign_recipients (
        id INT AUTO_INCREMENT PRIMARY KEY,
        campaign_id INT NOT NULL,
        contact_id INT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        sent_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_cr_campaign_contact (campaign_id, contact_id),
        INDEX idx_cr_campaign (campaign_id),
        INDEX idx_cr_contact (contact_id),
        CONSTRAINT fk_cr_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
        CONSTRAINT fk_cr_contact FOREIGN KEY (contact_id) REFERENCES contacts(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

export const collaborationSchema = {
    table: "collaboration_history",
    columns:
        "id, user_id, influencer_id, influencer_name, influencer_username, platform, profile_image, profile_url, recipient_email, subject, message, status, delivery_method, createdAt, updatedAt",
    createTable: `CREATE TABLE IF NOT EXISTS collaboration_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        influencer_id INT NULL,
        influencer_name VARCHAR(255) NOT NULL,
        influencer_username VARCHAR(255) NULL,
        platform VARCHAR(50) NOT NULL DEFAULT 'youtube',
        profile_image TEXT NULL,
        profile_url TEXT NULL,
        recipient_email VARCHAR(255) NOT NULL,
        subject VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'sent',
        delivery_method VARCHAR(64) NOT NULL DEFAULT 'smtp',
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_collab_user (user_id),
        INDEX idx_collab_influencer (influencer_id),
        INDEX idx_collab_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

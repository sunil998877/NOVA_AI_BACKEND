export const conversationSchema = {
    table: "conversations",
    columns:
        "id, user_id, influencer_id, campaign_id, status, last_message_id, last_message_at, title, thread_id, expiresAt, createdAt, updatedAt",
    updatable: ["title", "thread_id", "expiresAt", "influencer_id", "campaign_id", "status", "last_message_id", "last_message_at"],
    createTable: `CREATE TABLE IF NOT EXISTS conversations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        campaign_id BIGINT NULL,
        influencer_id BIGINT NULL,
        user_id BIGINT NOT NULL,
        status ENUM('active', 'archived', 'blocked') DEFAULT 'active',
        last_message_id BIGINT NULL,
        last_message_at DATETIME NULL,
        title VARCHAR(255) NULL DEFAULT 'Chat',
        thread_id VARCHAR(255) NULL,
        expiresAt DATETIME NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_conversations_user (user_id),
        INDEX idx_conversations_influencer (influencer_id),
        INDEX idx_conversations_last_msg (last_message_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

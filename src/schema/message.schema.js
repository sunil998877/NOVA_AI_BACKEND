export const messageSchema = {
    table: "messages",
    columns:
        "id, conversation_id, sender_id, sender_type, message, message_type, is_read, role, content, createdAt",
    createTable: `CREATE TABLE IF NOT EXISTS messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        conversation_id BIGINT NOT NULL,
        sender_id BIGINT NULL,
        sender_type ENUM('user', 'influencer', 'assistant', 'system') NOT NULL DEFAULT 'user',
        message TEXT NULL,
        message_type ENUM('text', 'image', 'file', 'system') DEFAULT 'text',
        is_read BOOLEAN DEFAULT FALSE,
        role VARCHAR(32) NULL,
        content TEXT NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_messages_conversation (conversation_id),
        INDEX idx_messages_sender (sender_id),
        INDEX idx_messages_created (createdAt),
        INDEX idx_messages_read (is_read)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

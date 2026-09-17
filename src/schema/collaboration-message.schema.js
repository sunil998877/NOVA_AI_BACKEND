export const collaborationMessageSchema = {
    table: "collaboration_messages",
    columns:
        "id, collaboration_id, sender_type, sender_name, content, read_at, createdAt, updatedAt",
    createTable: `CREATE TABLE IF NOT EXISTS collaboration_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        collaboration_id INT NOT NULL,
        sender_type ENUM('marketer', 'influencer') NOT NULL,
        sender_name VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        read_at TIMESTAMP NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_collab_msg_collab (collaboration_id),
        INDEX idx_collab_msg_created (createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

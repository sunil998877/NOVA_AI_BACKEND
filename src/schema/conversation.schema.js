export const conversationSchema = {
    table: "conversations",
    columns: "id, user_id, title, thread_id, expiresAt, createdAt, updatedAt",
    updatable: ["title", "thread_id", "expiresAt"],
    createTable: `CREATE TABLE IF NOT EXISTS conversations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL DEFAULT 'New conversation',
        thread_id VARCHAR(255) NULL,
        expiresAt DATETIME NOT NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_conversations_user (user_id),
        CONSTRAINT fk_conversations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

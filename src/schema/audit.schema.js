export const auditSchema = {
    table: "audit_logs",
    columns: "id, user_id, action, resource_id, ip_address, createdAt, updatedAt",
    createTable: `CREATE TABLE IF NOT EXISTS audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        action VARCHAR(128) NOT NULL,
        resource_id VARCHAR(64) NULL,
        ip_address VARCHAR(64) NOT NULL DEFAULT 'unknown',
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_audit_user (user_id),
        CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

export const suppressionSchema = {
    table: "suppressions",
    columns: "id, organization_id, type, value, reason, created_at",
    createTable: `CREATE TABLE IF NOT EXISTS suppressions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        type ENUM('EMAIL', 'PHONE', 'DOMAIN') NOT NULL,
        value VARCHAR(255) NOT NULL,
        reason VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_supp_org_type_val (organization_id, type, value),
        INDEX idx_supp_val (type, value)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

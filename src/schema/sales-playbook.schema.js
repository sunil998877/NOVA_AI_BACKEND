export const salesPlaybookSchema = {
    table: "sales_playbooks",
    columns: "id, organization_id, version, status, content, missing_fields, created_at, updated_at",
    updatable: ["version", "status", "content", "missing_fields"],
    createTable: `CREATE TABLE IF NOT EXISTS sales_playbooks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        version INT NOT NULL DEFAULT 1,
        status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
        content JSON NOT NULL,
        missing_fields JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_playbook_org (organization_id),
        INDEX idx_playbook_status (organization_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

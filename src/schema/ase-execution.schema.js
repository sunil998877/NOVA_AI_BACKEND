export const aseExecutionSchema = {
    table: "ase_executions",
    columns:
        "id, organization_id, lead_id, idempotency_key, action_type, status, payload, executed_at",
    createTable: `CREATE TABLE IF NOT EXISTS ase_executions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        lead_id INT NOT NULL,
        idempotency_key VARCHAR(191) NOT NULL,
        action_type VARCHAR(64) NOT NULL,
        status ENUM('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'RETRYING', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
        payload JSON NULL,
        executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_ase_idempotency (organization_id, idempotency_key),
        INDEX idx_ase_lead (lead_id),
        INDEX idx_ase_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

export const APPROVAL_STATUSES = Object.freeze({
    PENDING: "PENDING",
    APPROVED: "APPROVED",
    HELD: "HELD",
    REJECTED: "REJECTED",
    EXPIRED: "EXPIRED",
});

export const aseApprovalSchema = {
    table: "ase_approvals",
    columns:
        "id, organization_id, lead_id, action_type, status, payload, requested_at, reviewed_by, reviewed_at, created_at, updated_at",
    createTable: `CREATE TABLE IF NOT EXISTS ase_approvals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        lead_id INT NOT NULL,
        action_type VARCHAR(32) NOT NULL,
        status ENUM('PENDING', 'APPROVED', 'HELD', 'REJECTED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
        payload JSON NULL,
        requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_by INT NULL,
        reviewed_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        pending_slot TINYINT GENERATED ALWAYS AS (CASE WHEN status = 'PENDING' THEN 1 ELSE NULL END) STORED,
        UNIQUE KEY uq_ase_approval_pending (organization_id, lead_id, action_type, pending_slot),
        INDEX idx_ase_approval_org_status (organization_id, status),
        INDEX idx_ase_approval_lead (organization_id, lead_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

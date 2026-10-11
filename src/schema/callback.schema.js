export const callbackSchema = {
    table: "callbacks",
    columns:
        "id, organization_id, lead_id, assigned_rep_id, due_at, status, notes, source_event_id, completed_at, created_at, updated_at",
    updatable: [
        "assigned_rep_id",
        "due_at",
        "status",
        "notes",
        "completed_at",
    ],
    createTable: `CREATE TABLE IF NOT EXISTS callbacks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        lead_id INT NOT NULL,
        assigned_rep_id INT NULL,
        due_at DATETIME NOT NULL,
        status ENUM('OPEN', 'IN_PROGRESS', 'COMPLETED', 'MISSED', 'OVERDUE', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
        notes TEXT NULL,
        source_event_id INT NULL,
        completed_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_cb_org_status (organization_id, status),
        INDEX idx_cb_due (due_at),
        INDEX idx_cb_lead (lead_id),
        INDEX idx_cb_rep (assigned_rep_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

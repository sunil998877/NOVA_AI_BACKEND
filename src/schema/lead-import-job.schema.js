export const leadImportJobSchema = {
    table: "lead_import_jobs",
    columns:
        "id, organization_id, user_id, source, status, update_existing, total_rows, processed, accepted, created_count, updated_count, skipped, rejected, failed, error_summary, payload, created_at, updated_at, completed_at",
    createTable: `CREATE TABLE IF NOT EXISTS lead_import_jobs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        user_id INT NULL,
        source VARCHAR(32) NOT NULL DEFAULT 'CSV_IMPORT',
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        update_existing TINYINT(1) NOT NULL DEFAULT 0,
        total_rows INT NOT NULL DEFAULT 0,
        processed INT NOT NULL DEFAULT 0,
        accepted INT NOT NULL DEFAULT 0,
        created_count INT NOT NULL DEFAULT 0,
        updated_count INT NOT NULL DEFAULT 0,
        skipped INT NOT NULL DEFAULT 0,
        rejected INT NOT NULL DEFAULT 0,
        failed INT NOT NULL DEFAULT 0,
        error_summary JSON NULL,
        payload MEDIUMTEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        completed_at DATETIME NULL,
        INDEX idx_import_org_status (organization_id, status),
        INDEX idx_import_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

export const organizationSchema = {
    table: "organizations",
    columns: "id, name, slug, settings, created_at, updated_at",
    createTable: `CREATE TABLE IF NOT EXISTS organizations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(128) NOT NULL UNIQUE,
        settings JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_org_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

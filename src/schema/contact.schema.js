export const contactSchema = {
    table: "contacts",
    columns: "id, name, email, company, status, created_at, updated_at",
    updatable: ["name", "company", "status"],
    createTable: `CREATE TABLE IF NOT EXISTS contacts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        company VARCHAR(255) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_contacts_email (email),
        INDEX idx_contacts_email (email),
        INDEX idx_contacts_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

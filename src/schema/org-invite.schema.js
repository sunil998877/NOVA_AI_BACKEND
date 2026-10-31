export const orgInviteSchema = {
    table: "org_invites",
    columns:
        "id, organization_id, email, role, token_hash, invited_by, expires_at, accepted_at, created_at",
    createTable: `CREATE TABLE IF NOT EXISTS org_invites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        organization_id INT NOT NULL,
        email VARCHAR(255) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'SALESPERSON',
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        invited_by INT NULL,
        expires_at DATETIME NOT NULL,
        accepted_at DATETIME NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_invite_org (organization_id),
        INDEX idx_invite_email (email),
        INDEX idx_invite_hash (token_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

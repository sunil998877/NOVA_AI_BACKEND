export const userSchema = {
    table: "users",
    columns:
        "id, fullName, organization, email, passwordHash, googleId, authProvider, passwordResetTokenHash, passwordResetExpires, createdAt, updatedAt",
    updatable: [
        "fullName",
        "organization",
        "passwordHash",
        "googleId",
        "authProvider",
        "passwordResetTokenHash",
        "passwordResetExpires",
    ],
    createTable: `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        fullName VARCHAR(255) NOT NULL,
        organization VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        passwordHash VARCHAR(255) NULL,
        googleId VARCHAR(255) NULL UNIQUE,
        authProvider ENUM('local', 'google') NOT NULL DEFAULT 'local',
        passwordResetTokenHash VARCHAR(255) NULL,
        passwordResetExpires DATETIME NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};

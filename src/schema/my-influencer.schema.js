export const myInfluencerSchema = {
    table: "my_influencers",
    columns: "id, user_id, influencer_id, status, notes, lastContact, createdAt, updatedAt",
    updatable: ["status", "notes", "lastContact"],
    createTable: `CREATE TABLE IF NOT EXISTS my_influencers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        influencer_id INT NOT NULL,
        status VARCHAR(64) NOT NULL DEFAULT 'saved',
        notes TEXT NULL,
        lastContact DATETIME NULL,
        createdAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_user_influencer (user_id, influencer_id),
        INDEX idx_my_inf_user (user_id),
        INDEX idx_my_inf_influencer (influencer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
};


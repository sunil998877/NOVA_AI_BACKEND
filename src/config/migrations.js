import { tableStatements } from "../schema/index.js";

async function migrateCampaignCopyColumns(pool) {
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns'
               AND COLUMN_NAME IN ('subject', 'body', 'total_recipients', 'sent_count', 'failed_count')`
        );
        const existing = new Set(rows.map((row) => row.COLUMN_NAME));
        if (!existing.has("subject")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN subject VARCHAR(255) NULL AFTER status`);
        }
        if (!existing.has("body")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN body MEDIUMTEXT NULL AFTER subject`);
        }
        if (!existing.has("total_recipients")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN total_recipients INT NOT NULL DEFAULT 0 AFTER body`);
        }
        if (!existing.has("sent_count")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN sent_count INT NOT NULL DEFAULT 0 AFTER total_recipients`);
        }
        if (!existing.has("failed_count")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN failed_count INT NOT NULL DEFAULT 0 AFTER sent_count`);
        }
    } catch (error) {
        console.error("Could not migrate campaigns columns:", error.message);
    }
}

async function migrateMailDeliveryStatus(pool) {
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mails' AND COLUMN_NAME = 'delivery_status'`
        );
        if (!rows.length) {
            await pool.query(
                `ALTER TABLE mails ADD COLUMN delivery_status VARCHAR(32) NOT NULL DEFAULT 'pending' AFTER status`
            );
        }
    } catch (error) {
        console.error("Could not migrate mails delivery_status column:", error.message);
    }
}

async function migrateTrackingColumns(pool) {
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mails'
               AND COLUMN_NAME IN ('click_count', 'first_opened_at', 'last_opened_at')`
        );
        const existing = new Set(rows.map((row) => row.COLUMN_NAME));
        if (!existing.has("click_count")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN click_count INT NOT NULL DEFAULT 0 AFTER open_count`);
        }
        if (!existing.has("first_opened_at")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN first_opened_at DATETIME NULL AFTER click_count`);
        }
        if (!existing.has("last_opened_at")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN last_opened_at DATETIME NULL AFTER first_opened_at`);
        }
    } catch (error) {
        console.error("Could not migrate mails tracking columns:", error.message);
    }
}

async function migrateInfluencerTables(pool) {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS my_influencers (
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    } catch (e) {
        console.error("my_influencers creation error:", e.message);
    }

    try {
        const [infCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'influencers'`
        );
        const colSet = new Set(infCols.map((r) => r.COLUMN_NAME));

        if (!colSet.has("platform_user_id")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN platform_user_id VARCHAR(255) NULL AFTER platform`);
        }
        if (!colSet.has("username")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN username VARCHAR(255) NULL AFTER name`);
            if (colSet.has("handle")) {
                try {
                    await pool.query(`UPDATE influencers SET username = handle WHERE username IS NULL AND handle IS NOT NULL`);
                } catch (_) {}
            }
        }
        if (!colSet.has("email")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN email VARCHAR(255) NULL AFTER name`);
        }
        if (!colSet.has("profile_image")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN profile_image TEXT NULL`);
            if (colSet.has("avatar")) {
                try {
                    await pool.query(`UPDATE influencers SET profile_image = avatar WHERE profile_image IS NULL AND avatar IS NOT NULL`);
                } catch (_) {}
            }
        }
        if (!colSet.has("profile_url")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN profile_url TEXT NULL`);
        }
        if (!colSet.has("subscribers")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN subscribers BIGINT NULL`);
            if (colSet.has("followers")) {
                try {
                    await pool.query(`UPDATE influencers SET subscribers = CAST(followers AS UNSIGNED) WHERE subscribers IS NULL AND followers REGEXP '^[0-9]+$'`);
                } catch (_) {}
            }
        }
        if (!colSet.has("video_count")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN video_count BIGINT NULL`);
        }
        if (!colSet.has("view_count")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN view_count BIGINT NULL`);
        }
        if (!colSet.has("description")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN description TEXT NULL`);
            if (colSet.has("niche")) {
                try {
                    await pool.query(`UPDATE influencers SET description = niche WHERE description IS NULL AND niche IS NOT NULL`);
                } catch (_) {}
            }
        }

        try {
            await pool.query(`UPDATE influencers SET platform_user_id = COALESCE(NULLIF(username, ''), CONCAT(platform, '_', id)) WHERE platform_user_id IS NULL OR platform_user_id = ''`);
        } catch (_) {}

        try {
            await pool.query(`ALTER TABLE influencers ADD UNIQUE KEY unique_platform_user (platform, platform_user_id)`);
        } catch (_) {}

        try {
            await pool.query(`ALTER TABLE my_influencers MODIFY COLUMN influencer_id INT NOT NULL`);
        } catch (_) {}

        if (colSet.has("user_id")) {
            try {
                await pool.query(`ALTER TABLE influencers MODIFY COLUMN user_id INT NULL`);
            } catch (e) {
                console.warn("Could not modify user_id to nullable:", e.message);
            }
            try {
                await pool.query(
                    `INSERT IGNORE INTO my_influencers (user_id, influencer_id, status, notes, lastContact, createdAt, updatedAt)
                     SELECT user_id, id, COALESCE(status, 'saved'), notes, lastContact, createdAt, updatedAt FROM influencers WHERE user_id IS NOT NULL`
                );
            } catch (_) {}
        }
    } catch (error) {
        console.error("Could not migrate influencers tables:", error.message);
    }
}

async function cleanIndependentOrganization(pool) {
    try {
        await pool.query(
            `UPDATE users SET organization = '' WHERE LOWER(TRIM(organization)) = 'independent'`
        );
    } catch (error) {
        console.error("Could not clean up independent organization:", error.message);
    }
}

async function ensureCampaign50(pool) {
    try {
        const [users] = await pool.query(`SELECT id FROM users ORDER BY id ASC LIMIT 1`);
        const userId = users[0]?.id || 1;

        const [existing] = await pool.query(`SELECT id FROM campaigns WHERE id = 50 LIMIT 1`);
        if (!existing.length) {
            await pool.query(
                `INSERT INTO campaigns (id, title, sender_name, sender_email, status, camp_status, subject, body, total_recipients, user_id)
                 VALUES (50, 'Influencer Outreach', 'NOVA AI', 'nova@evokeaisolutions.com', 'processing', 'Processing', 'Collaboration Opportunity', 'We would love to collaborate with you!', 1, ?)`,
                [userId]
            );
        }

        const [existingMail] = await pool.query(`SELECT id FROM mails WHERE campaign_id = 50 LIMIT 1`);
        if (!existingMail.length) {
            await pool.query(
                `INSERT INTO mails (campaign_id, user_id, email, full_name, status, delivery_status)
                 VALUES (50, ?, 'creator@example.com', 'Creator', 0, 'pending')`,
                [userId]
            );
        }
    } catch (e) {
        console.warn("ensureCampaign50 error:", e.message);
    }
}

export async function runMigrations(pool) {
    for (const statement of tableStatements) {
        try {
            await pool.query(statement);
        } catch (error) {
            console.error("Schema statement error:", error.message);
        }
    }
    await Promise.allSettled([
        migrateCampaignCopyColumns(pool),
        migrateMailDeliveryStatus(pool),
        migrateTrackingColumns(pool),
        migrateInfluencerTables(pool),
        cleanIndependentOrganization(pool),
        ensureCampaign50(pool),
    ]);
}


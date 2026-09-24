import { tableStatements } from "../schema/index.js";

async function migrateCampaignCopyColumns(pool) {
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns'`
        );
        const existing = new Set(rows.map((row) => row.COLUMN_NAME));
        if (!existing.has("sender_name")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN sender_name VARCHAR(255) NULL AFTER title`);
            console.log("[Migration] Added column 'sender_name' to campaigns table");
        }
        if (!existing.has("sender_email")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN sender_email VARCHAR(255) NULL AFTER sender_name`);
            console.log("[Migration] Added column 'sender_email' to campaigns table");
        }
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

async function migrateEmailTrackingFeature(pool) {
    try {
        const [eeCols] = await pool.query(
            `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'email_events'`
        );
        const colMap = Object.fromEntries(eeCols.map((r) => [r.COLUMN_NAME, r.COLUMN_TYPE]));
        if (colMap.eventType && String(colMap.eventType).startsWith("enum")) {
            await pool.query(
                `ALTER TABLE email_events MODIFY COLUMN eventType VARCHAR(32) NOT NULL`
            );
        }
        if (!colMap.tracking_token) {
            await pool.query(
                `ALTER TABLE email_events ADD COLUMN tracking_token VARCHAR(64) NULL AFTER url`
            );
            try {
                await pool.query(`CREATE INDEX idx_ee_token ON email_events (tracking_token)`);
            } catch (_) {}
        }
    } catch (error) {
        console.error("Could not migrate email_events tracking columns:", error.message);
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
                } catch (_) { }
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
                } catch (_) { }
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
                } catch (_) { }
            }
        }
        if (!colSet.has("video_count")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN video_count BIGINT NULL`);
        }
        if (!colSet.has("view_count")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN view_count BIGINT NULL`);
        }
        if (!colSet.has("category")) {
            await pool.query(`ALTER TABLE influencers ADD COLUMN category VARCHAR(100) NULL DEFAULT 'General' AFTER location`);
        }

        try {
            const [myCols] = await pool.query(
                `SELECT COLUMN_NAME FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'my_influencers'`
            );
            const myColSet = new Set(myCols.map((r) => r.COLUMN_NAME));
            if (!myColSet.has("category")) {
                await pool.query(`ALTER TABLE my_influencers ADD COLUMN category VARCHAR(100) NULL DEFAULT 'General' AFTER status`);
            }
            await pool.query(
                `UPDATE my_influencers mi
                 JOIN influencers inf ON inf.id = mi.influencer_id
                 SET mi.category = 'Fitness'
                 WHERE (mi.category IS NULL OR mi.category = '' OR mi.category = 'General')
                   AND (inf.name LIKE '%fitness%' OR inf.name LIKE '%gym%' OR inf.name LIKE '%workout%')`
            );
            await pool.query(
                `UPDATE my_influencers mi
                 JOIN influencers inf ON inf.id = mi.influencer_id
                 SET mi.category = 'Technology'
                 WHERE (mi.category IS NULL OR mi.category = '' OR mi.category = 'General')
                   AND (inf.name LIKE '%tech%' OR inf.name LIKE '%code%' OR inf.name LIKE '%software%' OR inf.name LIKE '%david park%')`
            );
        } catch (_) {}

        try {
            await pool.query(`UPDATE influencers SET platform_user_id = COALESCE(NULLIF(username, ''), CONCAT(platform, '_', id)) WHERE platform_user_id IS NULL OR platform_user_id = ''`);
        } catch (_) { }

        try {
            await pool.query(`ALTER TABLE influencers ADD UNIQUE KEY unique_platform_user (platform, platform_user_id)`);
        } catch (_) { }

        try {
            await pool.query(`ALTER TABLE my_influencers MODIFY COLUMN influencer_id INT NOT NULL`);
        } catch (_) { }

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
            } catch (_) { }
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

async function migrateCollaborationChatTables(pool) {
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'collaboration_history'`
        );
        const colSet = new Set(rows.map((r) => r.COLUMN_NAME));

        if (!colSet.has("access_token")) {
            await pool.query(
                `ALTER TABLE collaboration_history ADD COLUMN access_token VARCHAR(64) NULL UNIQUE AFTER delivery_method`
            );
        }
        if (!colSet.has("whatsapp_number")) {
            await pool.query(
                `ALTER TABLE collaboration_history ADD COLUMN whatsapp_number VARCHAR(64) NULL AFTER access_token`
            );
        }
    } catch (e) {
        console.warn("migrateCollaborationChatTables error:", e.message);
    }
}

async function migrateChatSchema(pool) {
    try {
        const [convCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversations'`
        );
        const convSet = new Set(convCols.map((r) => r.COLUMN_NAME));

        if (!convSet.has("campaign_id")) {
            await pool.query(`ALTER TABLE conversations ADD COLUMN campaign_id BIGINT NULL AFTER id`);
        }
        if (!convSet.has("influencer_id")) {
            await pool.query(`ALTER TABLE conversations ADD COLUMN influencer_id BIGINT NULL AFTER campaign_id`);
        }
        if (!convSet.has("status")) {
            await pool.query(
                `ALTER TABLE conversations ADD COLUMN status ENUM('active', 'archived', 'blocked') DEFAULT 'active' AFTER user_id`
            );
        }
        if (!convSet.has("last_message_id")) {
            await pool.query(`ALTER TABLE conversations ADD COLUMN last_message_id BIGINT NULL AFTER status`);
        }
        if (!convSet.has("last_message_at")) {
            await pool.query(`ALTER TABLE conversations ADD COLUMN last_message_at DATETIME NULL AFTER last_message_id`);
        }

        const [msgCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages'`
        );
        const msgSet = new Set(msgCols.map((r) => r.COLUMN_NAME));

        if (!msgSet.has("sender_id")) {
            await pool.query(`ALTER TABLE messages ADD COLUMN sender_id BIGINT NULL AFTER conversation_id`);
        }
        if (!msgSet.has("sender_type")) {
            await pool.query(
                `ALTER TABLE messages ADD COLUMN sender_type ENUM('user', 'influencer', 'assistant', 'system') NOT NULL DEFAULT 'user' AFTER sender_id`
            );
        }
        if (!msgSet.has("message")) {
            await pool.query(`ALTER TABLE messages ADD COLUMN message TEXT NULL AFTER sender_type`);
            if (msgSet.has("content")) {
                await pool.query(`UPDATE messages SET message = content WHERE message IS NULL AND content IS NOT NULL`);
            }
        }
        if (!msgSet.has("message_type")) {
            await pool.query(
                `ALTER TABLE messages ADD COLUMN message_type ENUM('text', 'image', 'file', 'system') DEFAULT 'text' AFTER message`
            );
        }
        if (!msgSet.has("is_read")) {
            await pool.query(`ALTER TABLE messages ADD COLUMN is_read BOOLEAN DEFAULT FALSE AFTER message_type`);
        }

        try {
            await pool.query(`CREATE INDEX idx_conv_user ON conversations (user_id)`);
        } catch (_) {}
        try {
            await pool.query(`CREATE INDEX idx_conv_influencer ON conversations (influencer_id)`);
        } catch (_) {}
        try {
            await pool.query(`CREATE INDEX idx_conv_last_msg ON conversations (last_message_at)`);
        } catch (_) {}
        try {
            await pool.query(`CREATE INDEX idx_messages_conv ON messages (conversation_id)`);
        } catch (_) {}
        try {
            await pool.query(`CREATE INDEX idx_messages_sender ON messages (sender_id)`);
        } catch (_) {}
        try {
            await pool.query(`CREATE INDEX idx_messages_created ON messages (createdAt)`);
        } catch (_) {}
        try {
            await pool.query(`CREATE INDEX idx_messages_read ON messages (is_read)`);
        } catch (_) {}
    } catch (e) {
        console.warn("migrateChatSchema error:", e.message);
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

    await migrateCampaignCopyColumns(pool);

    await Promise.allSettled([
        migrateMailDeliveryStatus(pool),
        migrateTrackingColumns(pool),
        migrateEmailTrackingFeature(pool),
        migrateInfluencerTables(pool),
        cleanIndependentOrganization(pool),
        ensureCampaign50(pool),
        migrateCollaborationChatTables(pool),
        migrateChatSchema(pool),
    ]);
}


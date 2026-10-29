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

async function migrateAseFoundation(pool) {
    try {
        await pool.query(`
            INSERT INTO organizations (id, name, slug, settings)
            VALUES (1, 'Default Organization', 'default', '{}')
            ON DUPLICATE KEY UPDATE name = name
        `);
    } catch (_) {}

    try {
        const [uCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
        );
        const existingUserCols = new Set(uCols.map((r) => r.COLUMN_NAME));

        if (!existingUserCols.has("organization_id")) {
            await pool.query("ALTER TABLE users ADD COLUMN organization_id INT NOT NULL DEFAULT 1");
        }
        if (!existingUserCols.has("role")) {
            await pool.query("ALTER TABLE users ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT 'ORG_ADMIN'");
        }
        if (!existingUserCols.has("team")) {
            try { await pool.query("ALTER TABLE users ADD COLUMN team VARCHAR(64) NULL"); } catch (_) {}
        }
        if (!existingUserCols.has("territory")) {
            try { await pool.query("ALTER TABLE users ADD COLUMN territory VARCHAR(255) NULL"); } catch (_) {}
        }
    } catch (e) {
        console.warn("User migration error:", e.message);
    }

    try {
        const [lCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads'`
        );
        const existingLeadCols = new Set(lCols.map((r) => r.COLUMN_NAME));

        const leadColDefs = [
            ["organization_id", "INT NOT NULL DEFAULT 1"],
            ["first_name", "VARCHAR(128) NULL"],
            ["last_name", "VARCHAR(128) NULL"],
            ["whatsapp_number", "VARCHAR(64) NULL"],
            ["segment_attributes", "JSON NULL"],
            ["priority", "INT NOT NULL DEFAULT 50"],
            ["email_consent", "JSON NULL"],
            ["voice_consent", "JSON NULL"],
            ["whatsapp_consent", "JSON NULL"],
            ["assigned_rep_id", "INT NULL"],
            ["next_action", "VARCHAR(64) NULL"],
            ["next_action_time", "DATETIME NULL"],
            ["last_contacted_at", "DATETIME NULL"],
            ["attempt_counters", "JSON NULL"],
            ["callback_due", "DATETIME NULL"],
            ["disposition", "VARCHAR(64) NULL"],
            ["do_not_contact", "TINYINT(1) NOT NULL DEFAULT 0"],
            ["health", "VARCHAR(16) NOT NULL DEFAULT 'GREEN'"],
        ];

        for (const [colName, colType] of leadColDefs) {
            if (!existingLeadCols.has(colName)) {
                try {
                    await pool.query(`ALTER TABLE leads ADD COLUMN ${colName} ${colType}`);
                } catch (err) {
                    console.warn(`Could not add column ${colName} to leads:`, err.message);
                }
            }
        }
    } catch (e) {
        console.warn("Lead migration error:", e.message);
    }

    try {
        const [idxRows] = await pool.query(
            `SELECT INDEX_NAME FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads'`
        );
        const existingIndexes = new Set(idxRows.map((r) => r.INDEX_NAME));

        if (!existingIndexes.has("idx_leads_org")) {
            try { await pool.query("CREATE INDEX idx_leads_org ON leads (organization_id)"); } catch (_) {}
        }
        if (!existingIndexes.has("idx_leads_org_status")) {
            try { await pool.query("CREATE INDEX idx_leads_org_status ON leads (organization_id, status)"); } catch (_) {}
        }
        if (!existingIndexes.has("idx_leads_next_action")) {
            try { await pool.query("CREATE INDEX idx_leads_next_action ON leads (organization_id, next_action_time)"); } catch (_) {}
        }
        if (!existingIndexes.has("idx_leads_priority")) {
            try { await pool.query("CREATE INDEX idx_leads_priority ON leads (priority)"); } catch (_) {}
        }
        try {
            await pool.query(
                `UPDATE leads l
                 LEFT JOIN users u ON l.assigned_rep_id = u.id
                 SET l.assigned_rep_id = NULL
                 WHERE (u.email IS NOT NULL AND LOWER(l.email) = LOWER(u.email))
                    OR (l.source = 'SIGNUP' AND l.assigned_rep_id = l.user_id)`
            );
        } catch (error) {
            console.warn("Could not clean up self-assigned lead reps:", error.message);
        }
        if (!existingIndexes.has("uq_leads_org_phone")) {
            try {
                await pool.query("CREATE UNIQUE INDEX uq_leads_org_phone ON leads (organization_id, phone)");
            } catch (error) {
                console.warn("Could not add unique lead phone index:", error.message);
            }
        }
    } catch (_) {}

    try {
        const [crmCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'crm_connections'`
        );
        const existingCrmCols = new Set(crmCols.map((r) => r.COLUMN_NAME));
        if (crmCols.length > 0 && !existingCrmCols.has("organization_id")) {
            await pool.query("ALTER TABLE crm_connections ADD COLUMN organization_id INT NOT NULL DEFAULT 1 AFTER id");
            console.log("[Migration] Added column 'organization_id' to crm_connections table");
        }
    } catch (e) {
        console.warn("CRM connection migration error:", e.message);
    }

    try {
        const [cbCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'callbacks'`
        );
        const existingCbCols = new Set(cbCols.map((r) => r.COLUMN_NAME));
        if (cbCols.length > 0 && !existingCbCols.has("organization_id")) {
            await pool.query("ALTER TABLE callbacks ADD COLUMN organization_id INT NOT NULL DEFAULT 1 AFTER id");
            console.log("[Migration] Added column 'organization_id' to callbacks table");
        }
    } catch (e) {
        console.warn("Callbacks migration error:", e.message);
    }

    try {
        const [supCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppressions'`
        );
        const existingSupCols = new Set(supCols.map((r) => r.COLUMN_NAME));
        if (supCols.length > 0 && !existingSupCols.has("organization_id")) {
            await pool.query("ALTER TABLE suppressions ADD COLUMN organization_id INT NOT NULL DEFAULT 1 AFTER id");
            console.log("[Migration] Added column 'organization_id' to suppressions table");
        }
    } catch (e) {
        console.warn("Suppressions migration error:", e.message);
    }

    try {
        const [leCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lead_events'`
        );
        const existingLeCols = new Set(leCols.map((r) => r.COLUMN_NAME));
        if (leCols.length > 0 && !existingLeCols.has("organization_id")) {
            await pool.query("ALTER TABLE lead_events ADD COLUMN organization_id INT NOT NULL DEFAULT 1 AFTER id");
            console.log("[Migration] Added column 'organization_id' to lead_events table");
        }
    } catch (e) {
        console.warn("Lead events migration error:", e.message);
    }
}

async function migrateTelephonyAndCallbacks(pool) {
    try {
        const [cbCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'callbacks'`
        );
        const cbColSet = new Set(cbCols.map((r) => r.COLUMN_NAME));

        if (cbCols.length > 0) {
            if (!cbColSet.has("call_id")) {
                try {
                    await pool.query("ALTER TABLE callbacks ADD COLUMN call_id INT NULL AFTER lead_id");
                } catch (_) {}
            }
            if (!cbColSet.has("requested_at")) {
                try {
                    await pool.query("ALTER TABLE callbacks ADD COLUMN requested_at DATETIME NULL AFTER due_at");
                } catch (_) {}
            }
            if (!cbColSet.has("actual_outcome")) {
                try {
                    await pool.query("ALTER TABLE callbacks ADD COLUMN actual_outcome VARCHAR(64) NULL AFTER status");
                } catch (_) {}
            }
            if (!cbColSet.has("follow_up_action")) {
                try {
                    await pool.query("ALTER TABLE callbacks ADD COLUMN follow_up_action VARCHAR(64) NULL AFTER actual_outcome");
                } catch (_) {}
            }
            if (!cbColSet.has("sla_status")) {
                try {
                    await pool.query("ALTER TABLE callbacks ADD COLUMN sla_status VARCHAR(32) NOT NULL DEFAULT 'ON_TRACK' AFTER follow_up_action");
                } catch (_) {}
            }
            if (!cbColSet.has("sla_breached_at")) {
                try {
                    await pool.query("ALTER TABLE callbacks ADD COLUMN sla_breached_at DATETIME NULL AFTER sla_status");
                } catch (_) {}
            }
            try {
                await pool.query("ALTER TABLE callbacks MODIFY COLUMN status VARCHAR(32) NOT NULL DEFAULT 'OPEN'");
            } catch (_) {}
        }
    } catch (err) {
        console.warn("Telephony callback migration error:", err.message);
    }
}

async function syncUsersToLeads(pool) {
    try {
        await pool.query("DELETE FROM leads WHERE source = 'SIGNUP'");
    } catch (_) {}
}

async function migrateMukhStyleEmailEngine(pool) {
    try {
        const [campCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns'`
        );
        const existingCamp = new Set(campCols.map((c) => c.COLUMN_NAME));
        if (!existingCamp.has("min_delay_seconds")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN min_delay_seconds INT NOT NULL DEFAULT 5 AFTER failed_count`);
        }
        if (!existingCamp.has("max_delay_seconds")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN max_delay_seconds INT NOT NULL DEFAULT 15 AFTER min_delay_seconds`);
        }
        if (!existingCamp.has("max_concurrency")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN max_concurrency INT NOT NULL DEFAULT 2 AFTER max_delay_seconds`);
        }
        if (!existingCamp.has("sending_window_start")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN sending_window_start VARCHAR(10) NOT NULL DEFAULT '08:00' AFTER max_concurrency`);
        }
        if (!existingCamp.has("sending_window_end")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN sending_window_end VARCHAR(10) NOT NULL DEFAULT '18:00' AFTER sending_window_start`);
        }
        if (!existingCamp.has("sending_days")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN sending_days JSON NULL AFTER sending_window_end`);
        }
        if (!existingCamp.has("timezone")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN timezone VARCHAR(64) NOT NULL DEFAULT 'UTC' AFTER sending_days`);
        }
        if (!existingCamp.has("daily_cap")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN daily_cap INT NOT NULL DEFAULT 500 AFTER timezone`);
        }
        if (!existingCamp.has("hourly_cap")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN hourly_cap INT NOT NULL DEFAULT 100 AFTER daily_cap`);
        }
        if (!existingCamp.has("sender_account_id")) {
            await pool.query(`ALTER TABLE campaigns ADD COLUMN sender_account_id INT NULL AFTER hourly_cap`);
        }

        const [mailCols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mails'`
        );
        const existingMail = new Set(mailCols.map((c) => c.COLUMN_NAME));
        if (!existingMail.has("idempotency_key")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN idempotency_key VARCHAR(128) NULL AFTER delivery_status`);
        }
        if (!existingMail.has("sender_account_id")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN sender_account_id INT NULL AFTER idempotency_key`);
        }
        if (!existingMail.has("scheduled_at")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN scheduled_at DATETIME NULL AFTER sender_account_id`);
        }
        if (!existingMail.has("locked_at")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN locked_at DATETIME NULL AFTER scheduled_at`);
        }
        if (!existingMail.has("locked_by")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN locked_by VARCHAR(64) NULL AFTER locked_at`);
        }
        if (!existingMail.has("attempts_count")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN attempts_count INT NOT NULL DEFAULT 0 AFTER locked_by`);
        }
        if (!existingMail.has("last_error")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN last_error TEXT NULL AFTER attempts_count`);
        }
        if (!existingMail.has("message_id")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN message_id VARCHAR(255) NULL AFTER last_error`);
        }
        if (!existingMail.has("skip_reason")) {
            await pool.query(`ALTER TABLE mails ADD COLUMN skip_reason VARCHAR(128) NULL AFTER message_id`);
        }
    } catch (e) {
        console.warn("[Migration] migrateMukhStyleEmailEngine warning:", e.message);
    }
}

export async function migrateLeadEventIdempotency(pool) {
    try {
        const [cols] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lead_events'`
        );
        const colSet = new Set(cols.map((r) => r.COLUMN_NAME));
        if (!colSet.has("idempotency_key")) {
            await pool.query(`ALTER TABLE lead_events ADD COLUMN idempotency_key VARCHAR(255) NULL AFTER payload`);
            try {
                await pool.query(`ALTER TABLE lead_events ADD INDEX idx_le_idempotency (organization_id, idempotency_key)`);
            } catch (_) {}
        }
    } catch (e) {
        console.warn("[Migration] migrateLeadEventIdempotency warning:", e.message);
    }
}

async function migrateFollowUpSequences(pool) {
    try {
        const [rows] = await pool.query(
            `SELECT id FROM follow_up_sequences WHERE organization_id = 1 LIMIT 1`
        );
        if (!rows || rows.length === 0) {
            const defaultSteps = [
                {
                    stepNumber: 1,
                    dayOffset: 2,
                    threadMode: "REPLY_THREAD",
                    name: "Follow-up 1: Helpful in-thread touch",
                    description: "Continue existing thread with concise, helpful problem inquiry. No calendar link.",
                },
                {
                    stepNumber: 2,
                    dayOffset: 7,
                    threadMode: "NEW_THREAD",
                    name: "Follow-up 2: Relevant insight & case study",
                    description: "Start a new thread with a practical suggestion, metric, or industry observation.",
                },
                {
                    stepNumber: 3,
                    dayOffset: 14,
                    threadMode: "NEW_THREAD",
                    name: "Follow-up 3: Objection handling & resources",
                    description: "Address likely hesitation, offer useful resource, invite questions.",
                },
                {
                    stepNumber: 4,
                    dayOffset: 28,
                    threadMode: "NEW_THREAD",
                    name: "Follow-up 4: Personalized video concept",
                    description: "Custom video concept or tailored script draft for review.",
                },
                {
                    stepNumber: 5,
                    dayOffset: 42,
                    threadMode: "REPLY_THREAD",
                    name: "Follow-up 5: Polite final check-in",
                    description: "Courteous final check-in, then pause the automated sequence.",
                },
            ];

            await pool.query(
                `INSERT INTO follow_up_sequences (
                    organization_id, name, description, is_active, steps_config,
                    sending_window_start, sending_window_end, sending_days, timezone
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    1,
                    "Default Cold Outreach Sequence (5 Touches)",
                    "Production-ready date-wise follow-up sequence: Day 2, Day 7, Day 14, Day 28, Day 42.",
                    1,
                    JSON.stringify(defaultSteps),
                    "09:00",
                    "18:00",
                    JSON.stringify([1, 2, 3, 4, 5]),
                    "UTC",
                ]
            );
        }

        try {
            await pool.query(`ALTER TABLE follow_up_enrollments MODIFY COLUMN status VARCHAR(64) NOT NULL DEFAULT 'active'`);
        } catch (_) {}

        try {
            await pool.query(`ALTER TABLE follow_up_tasks MODIFY COLUMN status VARCHAR(64) NOT NULL DEFAULT 'SCHEDULED'`);
        } catch (_) {}

        const alterations = [
            "ALTER TABLE follow_up_enrollments ADD COLUMN reply_message_id VARCHAR(255) NULL",
            "ALTER TABLE follow_up_enrollments ADD COLUMN reply_subject VARCHAR(255) NULL",
            "ALTER TABLE follow_up_enrollments ADD COLUMN reply_outcome VARCHAR(64) NULL",
            "ALTER TABLE follow_up_enrollments ADD COLUMN reply_received_at DATETIME NULL",
            "ALTER TABLE follow_up_enrollments ADD COLUMN reply_processed_at DATETIME NULL",
            "ALTER TABLE follow_up_enrollments ADD COLUMN reply_processed_by VARCHAR(128) NULL",
            "ALTER TABLE follow_up_enrollments ADD COLUMN resumed_at DATETIME NULL",
            "ALTER TABLE follow_up_enrollments ADD COLUMN resumed_by VARCHAR(128) NULL",
            "ALTER TABLE follow_up_enrollments ADD COLUMN resumed_reason VARCHAR(255) NULL",
        ];

        for (const alterSql of alterations) {
            try {
                await pool.query(alterSql);
            } catch (_) {}
        }
    } catch (error) {
        console.warn("[Migration] migrateFollowUpSequences warning:", error.message);
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
        migrateAseFoundation(pool),
        migrateTelephonyAndCallbacks(pool),
        syncUsersToLeads(pool),
        migrateMukhStyleEmailEngine(pool),
        migrateLeadEventIdempotency(pool),
        migrateFollowUpSequences(pool),
        migrateOrgOperatingMode(pool),
        migrateUncheckedVoiceConsentToUnknown(pool),
    ]);
}

async function migrateUncheckedVoiceConsentToUnknown(pool) {
    try {
        const [result] = await pool.query(`
            UPDATE leads
            SET voice_consent = JSON_SET(
                COALESCE(voice_consent, JSON_OBJECT('source', 'MANUAL')),
                '$.status', 'UNKNOWN'
            )
            WHERE JSON_UNQUOTE(JSON_EXTRACT(voice_consent, '$.status')) = 'DENIED'
              AND LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(voice_consent, '$.source')), 'manual'))
                  IN ('manual', 'form', 'ingestion', 'ui')
        `);
        if (result?.affectedRows) {
            console.log(`[Migration] Reset ${result.affectedRows} unchecked voice DENIED records to UNKNOWN`);
        }
    } catch (error) {
        console.warn("[Migration] voice consent reset warning:", error.message);
    }
}

async function migrateOrgOperatingMode(pool) {
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organizations' AND COLUMN_NAME = 'operating_mode'`
        );
        if (!rows.length) {
            await pool.query(
                `ALTER TABLE organizations
                 ADD COLUMN operating_mode VARCHAR(32) NOT NULL DEFAULT 'FULLY_AUTOMATED' AFTER settings`
            );
            console.log("[Migration] Added column 'operating_mode' to organizations");
        }
    } catch (error) {
        console.warn("[Migration] migrateOrgOperatingMode warning:", error.message);
    }
}



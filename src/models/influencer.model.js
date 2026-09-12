import { execute, query } from "../config/db.js";
import { influencerSchema } from "../schema/influencer.schema.js";
import { myInfluencerSchema } from "../schema/my-influencer.schema.js";
import { mapRow } from "./mapRow.js";

const { table: infTable } = influencerSchema;
const { table: myInfTable } = myInfluencerSchema;

export const Influencer = {
    async findByUser(userId) {
        try {
            const rows = await query(
                `SELECT mi.id, mi.user_id, mi.influencer_id, mi.status, mi.notes, mi.lastContact, mi.createdAt, mi.updatedAt,
                        inf.platform,
                        COALESCE(inf.platform_user_id, CAST(inf.id AS CHAR)) AS platform_user_id,
                        inf.name,
                        COALESCE(inf.username, inf.name) AS username,
                        inf.email,
                        inf.description,
                        inf.profile_image,
                        inf.profile_url,
                        inf.subscribers,
                        inf.video_count,
                        inf.view_count,
                        inf.location
                 FROM ${myInfTable} mi
                 INNER JOIN ${infTable} inf ON inf.id = mi.influencer_id
                 WHERE mi.user_id = ?
                 ORDER BY mi.updatedAt DESC`,
                [userId]
            );
            return rows.map((r) => {
                const mapped = mapRow(r);
                return {
                    ...mapped,
                    followers: mapped.subscribers,
                };
            });
        } catch (err) {
            console.error("findByUser error:", err.message);
            try {
                const legacyRows = await query(
                    `SELECT id, user_id, name, platform, location, status, notes, lastContact, createdAt, updatedAt
                     FROM ${infTable}
                     WHERE user_id = ?
                     ORDER BY updatedAt DESC`,
                    [userId]
                );
                return legacyRows.map((r) => mapRow(r));
            } catch {
                return [];
            }
        }
    },

    async findSavedPlatformUserIds(userId) {
        try {
            const rows = await query(
                `SELECT inf.platform, inf.platform_user_id, mi.id AS saved_id
                 FROM ${myInfTable} mi
                 INNER JOIN ${infTable} inf ON inf.id = mi.influencer_id
                 WHERE mi.user_id = ?`,
                [userId]
            );
            return rows.map((r) => ({
                id: String(r.saved_id),
                platform: r.platform,
                platformUserId: r.platform_user_id,
            }));
        } catch (err) {
            console.error("findSavedPlatformUserIds error:", err.message);
            return [];
        }
    },

    async findOwned(id, userId) {
        try {
            const rows = await query(
                `SELECT mi.id, mi.user_id, mi.influencer_id, mi.status, mi.notes, mi.lastContact, mi.createdAt, mi.updatedAt,
                        inf.platform,
                        COALESCE(inf.platform_user_id, CAST(inf.id AS CHAR)) AS platform_user_id,
                        inf.name,
                        COALESCE(inf.username, inf.name) AS username,
                        inf.email,
                        inf.description,
                        inf.profile_image,
                        inf.profile_url,
                        inf.subscribers,
                        inf.video_count,
                        inf.view_count,
                        inf.location
                 FROM ${myInfTable} mi
                 INNER JOIN ${infTable} inf ON inf.id = mi.influencer_id
                 WHERE (mi.id = ? OR mi.influencer_id = ?) AND mi.user_id = ?
                 LIMIT 1`,
                [id, id, userId]
            );
            if (!rows.length) return null;
            const mapped = mapRow(rows[0]);
            return {
                ...mapped,
                followers: mapped.subscribers,
            };
        } catch (err) {
            console.error("findOwned error:", err.message);
            return null;
        }
    },

    async upsertAndSave(userId, data) {
        const platform = String(data.platform || "youtube").toLowerCase();
        const platformUserId = String(data.platformUserId || data.handle || data.name).trim();
        const name = String(data.name || "Unknown").trim();
        const username = data.username ? String(data.username).trim() : null;
        const email = data.email ? String(data.email).trim() : null;
        const description = data.description ? String(data.description).trim() : null;
        const profileImage = data.profileImage || data.avatar || null;
        const profileUrl = data.profileUrl || null;
        const subscribers = data.subscribers !== undefined && data.subscribers !== null ? Number(data.subscribers) : null;
        const videoCount = data.videoCount !== undefined && data.videoCount !== null ? Number(data.videoCount) : null;
        const viewCount = data.viewCount !== undefined && data.viewCount !== null ? Number(data.viewCount) : null;
        const location = data.location || null;
        const status = data.status || "saved";
        const notes = data.notes || null;

        let influencerId = null;

        // 1. Insert or update global influencers table
        try {
            const insertResult = await execute(
                `INSERT INTO ${infTable}
                 (platform, platform_user_id, name, username, email, description, profile_image, profile_url, subscribers, video_count, view_count, location)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    name = VALUES(name),
                    username = COALESCE(VALUES(username), username),
                    email = COALESCE(VALUES(email), email),
                    description = COALESCE(VALUES(description), description),
                    profile_image = COALESCE(VALUES(profile_image), profile_image),
                    profile_url = COALESCE(VALUES(profile_url), profile_url),
                    subscribers = COALESCE(VALUES(subscribers), subscribers),
                    video_count = COALESCE(VALUES(video_count), video_count),
                    view_count = COALESCE(VALUES(view_count), view_count),
                    location = COALESCE(VALUES(location), location),
                    updatedAt = CURRENT_TIMESTAMP`,
                [
                    platform,
                    platformUserId,
                    name,
                    username,
                    email,
                    description,
                    profileImage,
                    profileUrl,
                    subscribers,
                    videoCount,
                    viewCount,
                    location,
                ]
            );
            if (insertResult?.insertId) {
                influencerId = insertResult.insertId;
            }
        } catch (insertErr) {
            console.warn("Primary influencer insert failed, attempting schema-compatible fallback:", insertErr.message);

            // Attempt to make user_id nullable if it was NOT NULL
            try {
                await query(`ALTER TABLE ${infTable} MODIFY COLUMN user_id INT NULL`);
            } catch (_) {}

            // Retry with user_id included if user_id column is required
            try {
                const retryResult = await execute(
                    `INSERT INTO ${infTable}
                     (user_id, platform, platform_user_id, name, username, email, description, profile_image, profile_url, subscribers, video_count, view_count, location)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        name = VALUES(name),
                        updatedAt = CURRENT_TIMESTAMP`,
                    [userId, platform, platformUserId, name, username, email, description, profileImage, profileUrl, subscribers, videoCount, viewCount, location]
                );
                if (retryResult?.insertId) influencerId = retryResult.insertId;
            } catch {
                // Retry standard insert after alter
                try {
                    const retryResult = await execute(
                        `INSERT INTO ${infTable}
                         (platform, platform_user_id, name, username, email, description, profile_image, profile_url, subscribers, video_count, view_count, location)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE
                            name = VALUES(name),
                            updatedAt = CURRENT_TIMESTAMP`,
                        [platform, platformUserId, name, username, email, description, profileImage, profileUrl, subscribers, videoCount, viewCount, location]
                    );
                    if (retryResult?.insertId) influencerId = retryResult.insertId;
                } catch {
                    // Minimal legacy insert fallback
                    const minResult = await execute(
                        `INSERT INTO ${infTable} (user_id, name, platform, status)
                         VALUES (?, ?, ?, ?)`,
                        [userId, name, platform, status]
                    );
                    influencerId = minResult.insertId;
                }
            }
        }

        // 2. Query influencer id if insertId was not returned
        if (!influencerId) {
            try {
                const infRows = await query(
                    `SELECT id FROM ${infTable} WHERE platform = ? AND platform_user_id = ? LIMIT 1`,
                    [platform, platformUserId]
                );
                influencerId = infRows[0]?.id;
            } catch (_) {}
        }

        if (!influencerId) {
            try {
                const infRows = await query(
                    `SELECT id FROM ${infTable} WHERE name = ? ORDER BY id DESC LIMIT 1`,
                    [name]
                );
                influencerId = infRows[0]?.id;
            } catch (_) {}
        }

        if (!influencerId) {
            throw new Error(`Failed to resolve influencer ID for ${platform}:${platformUserId}`);
        }

        // 3. Upsert into my_influencers table
        try {
            await execute(
                `INSERT INTO ${myInfTable} (user_id, influencer_id, status, notes)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    status = VALUES(status),
                    notes = COALESCE(VALUES(notes), notes),
                    updatedAt = CURRENT_TIMESTAMP`,
                [userId, influencerId, status, notes]
            );
        } catch (myInfErr) {
            console.warn("my_influencers insert error, checking table creation:", myInfErr.message);
            try {
                await query(`CREATE TABLE IF NOT EXISTS ${myInfTable} (
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

                await execute(
                    `INSERT INTO ${myInfTable} (user_id, influencer_id, status, notes)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        status = VALUES(status),
                        notes = COALESCE(VALUES(notes), notes),
                        updatedAt = CURRENT_TIMESTAMP`,
                    [userId, influencerId, status, notes]
                );
            } catch {
                // If my_influencers join table cannot be used, ensure status is set on infTable directly
                try {
                    await execute(
                        `UPDATE ${infTable} SET status = ?, user_id = COALESCE(user_id, ?) WHERE id = ?`,
                        [status, userId, influencerId]
                    );
                } catch (_) {}
            }
        }

        // 4. Return saved record
        const owned = await this.findOwned(influencerId, userId);
        if (owned) return owned;

        return {
            id: String(influencerId),
            _id: String(influencerId),
            user_id: String(userId),
            influencer_id: influencerId,
            platform,
            platformUserId,
            name,
            username,
            email,
            description,
            profileImage,
            profileUrl,
            subscribers,
            followers: subscribers,
            videoCount,
            viewCount,
            location,
            status,
            notes,
        };
    },

    async updateStatus(id, userId, { status, notes, lastContact, email }) {
        const owned = await this.findOwned(id, userId);
        if (!owned) return null;

        const updates = [];
        const params = [];

        if (status) {
            updates.push("status = ?");
            params.push(status);
        }
        if (notes !== undefined) {
            updates.push("notes = ?");
            params.push(notes);
        }
        if (lastContact) {
            updates.push("lastContact = ?");
            params.push(lastContact);
        }

        if (updates.length > 0) {
            params.push(owned.id, userId);
            try {
                await execute(
                    `UPDATE ${myInfTable} SET ${updates.join(", ")}, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
                    params
                );
            } catch (_) {
                try {
                    await execute(
                        `UPDATE ${infTable} SET ${updates.join(", ")}, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
                        params
                    );
                } catch (_) {}
            }
        }

        if (email) {
            try {
                await execute(
                    `UPDATE ${infTable} SET email = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`,
                    [email, owned.influencer_id || owned.id]
                );
            } catch (_) {}
        }

        return this.findOwned(owned.id, userId);
    },

    async remove(id, userId) {
        let removed = false;
        try {
            const result = await execute(
                `DELETE FROM ${myInfTable} WHERE (id = ? OR influencer_id = ?) AND user_id = ?`,
                [id, id, userId]
            );
            removed = result.affectedRows > 0;
        } catch (_) {}

        if (!removed) {
            try {
                const legacyResult = await execute(
                    `DELETE FROM ${infTable} WHERE id = ? AND user_id = ?`,
                    [id, userId]
                );
                removed = legacyResult.affectedRows > 0;
            } catch (_) {}
        }
        return removed;
    },
};

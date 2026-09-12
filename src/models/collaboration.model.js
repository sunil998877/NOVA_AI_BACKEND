import { execute, query } from "../config/db.js";
import { collaborationSchema } from "../schema/collaboration.schema.js";
import { mapRow } from "./mapRow.js";

const { table, columns, createTable } = collaborationSchema;

export const Collaboration = {
    async ensureTable() {
        try {
            await query(createTable);
        } catch (_) {}
    },

    async findById(id, userId) {
        await this.ensureTable();
        const rows = await query(
            `SELECT ${columns} FROM ${table} WHERE id = ? AND user_id = ? LIMIT 1`,
            [id, userId]
        );
        return rows[0] ? mapRow(rows[0]) : null;
    },

    async listByUser(userId, { q = "", platform = "", status = "", skip = 0, limit = 50 } = {}) {
        await this.ensureTable();
        const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const safeSkip = Math.max(Number(skip) || 0, 0);

        let where = "WHERE user_id = ?";
        const params = [userId];

        if (platform && platform !== "all") {
            where += " AND platform = ?";
            params.push(String(platform).toLowerCase());
        }

        if (status && status !== "all") {
            where += " AND status = ?";
            params.push(String(status).toLowerCase());
        }

        if (q && q.trim()) {
            where += " AND (influencer_name LIKE ? OR recipient_email LIKE ? OR subject LIKE ? OR influencer_username LIKE ?)";
            const like = `%${q.trim()}%`;
            params.push(like, like, like, like);
        }

        const rows = await query(
            `SELECT ${columns} FROM ${table} ${where} ORDER BY createdAt DESC LIMIT ${safeLimit} OFFSET ${safeSkip}`,
            params
        );
        return rows.map(mapRow);
    },

    async countByUser(userId, { q = "", platform = "", status = "" } = {}) {
        await this.ensureTable();
        let where = "WHERE user_id = ?";
        const params = [userId];

        if (platform && platform !== "all") {
            where += " AND platform = ?";
            params.push(String(platform).toLowerCase());
        }

        if (status && status !== "all") {
            where += " AND status = ?";
            params.push(String(status).toLowerCase());
        }

        if (q && q.trim()) {
            where += " AND (influencer_name LIKE ? OR recipient_email LIKE ? OR subject LIKE ? OR influencer_username LIKE ?)";
            const like = `%${q.trim()}%`;
            params.push(like, like, like, like);
        }

        const rows = await query(
            `SELECT COUNT(*) AS total FROM ${table} ${where}`,
            params
        );
        return Number(rows[0]?.total || 0);
    },

    async create({
        userId,
        influencerId,
        influencerName,
        influencerUsername,
        platform,
        profileImage,
        profileUrl,
        recipientEmail,
        subject,
        message,
        status = "sent",
        deliveryMethod = "smtp",
    }) {
        await this.ensureTable();
        const result = await execute(
            `INSERT INTO ${table} (user_id, influencer_id, influencer_name, influencer_username, platform, profile_image, profile_url, recipient_email, subject, message, status, delivery_method)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userId,
                influencerId || null,
                influencerName || "Creator",
                influencerUsername || null,
                platform || "youtube",
                profileImage || null,
                profileUrl || null,
                String(recipientEmail).trim(),
                String(subject).trim(),
                String(message).trim(),
                status,
                deliveryMethod,
            ]
        );
        return this.findById(result.insertId, userId);
    },

    async updateStatus(id, userId, status) {
        await this.ensureTable();
        await execute(
            `UPDATE ${table} SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`,
            [status, id, userId]
        );
        return this.findById(id, userId);
    },

    async delete(id, userId) {
        await this.ensureTable();
        const result = await execute(
            `DELETE FROM ${table} WHERE id = ? AND user_id = ?`,
            [id, userId]
        );
        return result.affectedRows > 0;
    },
};

import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const getPerformance = asyncHandler(async (req, res) => {
    const rows = await query(
        `SELECT
            COUNT(m.id) AS total,
            COALESCE(SUM(CASE WHEN m.status = 1 OR m.sent_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS delivered,
            COALESCE(SUM(CASE WHEN m.open_count > 0 THEN 1 ELSE 0 END), 0) AS opened,
            COUNT(DISTINCT c.id) AS campaigns
         FROM campaigns c
         LEFT JOIN mails m ON m.campaign_id = c.id
         WHERE c.user_id = ?`,
        [req.user.id]
    );
    const row = rows[0] || {};
    const total = Number(row.total || 0);
    const delivered = Number(row.delivered || 0);
    const opened = Number(row.opened || 0);

    return res.status(200).json({
        total,
        delivered,
        opened,
        campaigns: Number(row.campaigns || 0),
    });
});

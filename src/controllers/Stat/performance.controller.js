import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const getPerformance = asyncHandler(async (req, res) => {
    const rows = await query(
        `SELECT
            COUNT(m.id) AS total,
            COALESCE(SUM(CASE WHEN m.status = 1 OR m.sent_at IS NOT NULL OR m.delivery_status != 'failed' THEN 1 ELSE 0 END), 0) AS delivered,
            COALESCE(SUM(CASE WHEN m.open_count > 0 OR m.delivery_status = 'opened' THEN 1 ELSE 0 END), 0) AS opened,
            COALESCE(SUM(CASE WHEN m.click_count > 0 THEN 1 ELSE 0 END), 0) AS clicked,
            COALESCE(SUM(CASE WHEN m.open_count > 0 THEN m.open_count WHEN m.delivery_status = 'opened' THEN 1 ELSE 0 END), 0) AS totalOpens,
            COALESCE(SUM(m.click_count), 0) AS totalClicks,
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
    const clicked = Number(row.clicked || 0);
    const totalOpens = Number(row.totalOpens || 0);
    const totalClicks = Number(row.totalClicks || 0);
    const unopened = Math.max(delivered - opened, 0);
    const openRate = delivered > 0 ? Number(((opened / delivered) * 100).toFixed(1)) : 0;
    const clickRate = delivered > 0 ? Number(((clicked / delivered) * 100).toFixed(1)) : 0;

    return res.status(200).json({
        total,
        delivered,
        opened,
        unopened,
        clicked,
        uniqueOpens: opened,
        totalOpens,
        uniqueClicks: clicked,
        totalClicks,
        openRate,
        clickRate,
        campaigns: Number(row.campaigns || 0),
    });
});

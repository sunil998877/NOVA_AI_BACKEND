import { Campaign } from "../../models/campaign.model.js";
import { audit } from "../../utils/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { toMysqlDateTime } from "../../utils/datetime.js";

export const updateCampaign = asyncHandler(async (req, res) => {
    const existing = await Campaign.findOwned(req.params.id, req.user.id);
    if (!existing) {
        return res.status(403).json({ error: "Access denied: You do not own this campaign" });
    }

    const {
        title,
        campaign_name,
        workMail,
        work_mail,
        followups,
        camp_status,
        scheduledDate,
        scheduled_date,
        status,
        subject,
        body,
    } = req.body;

    const rawScheduledDate = scheduledDate ?? scheduled_date;
    const updated = await Campaign.updateById(existing.id, {
        title: title || campaign_name,
        workMail: workMail ?? work_mail,
        followups,
        camp_status,
        scheduledDate:
            rawScheduledDate === undefined ? undefined : toMysqlDateTime(rawScheduledDate),
        status,
        subject: subject ?? undefined,
        body: body ?? undefined,
    });

    await audit(req.user.id, "CAMPAIGN_UPDATE", updated._id, req.ip);
    return res.status(200).json(updated);
});

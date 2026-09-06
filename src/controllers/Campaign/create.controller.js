import { Campaign } from "../../models/campaign.model.js";
import { audit } from "../../utils/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { toMysqlDateTime } from "../../utils/datetime.js";

export const createCampaign = asyncHandler(async (req, res) => {
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

    const resolvedTitle = title || campaign_name;
    if (!resolvedTitle) {
        return res.status(400).json({ error: "Campaign name is required" });
    }

    const campaign = await Campaign.create({
        title: resolvedTitle,
        workMail: workMail ?? work_mail ?? null,
        followups: followups ?? "0",
        camp_status: camp_status ?? "Pending",
        scheduledDate: toMysqlDateTime(scheduledDate ?? scheduled_date),
        status: status || "draft",
        subject: subject ?? null,
        body: body ?? null,
        user_id: req.user.id,
    });

    await audit(req.user.id, "CAMPAIGN_CREATE", campaign._id, req.ip);
    return res.status(201).json(campaign);
});

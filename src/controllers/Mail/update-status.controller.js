import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { toMysqlDateTime } from "../../utils/datetime.js";

export const updateMailStatus = asyncHandler(async (req, res) => {
    const mail = await Mail.findById(req.params.id);
    if (!mail) {
        return res.status(404).json({ error: "Mail not found" });
    }

    if (req.authVia === "n8n_campaign_token") {
        if (String(req.n8nCampaignId) !== String(mail.campaign_id)) {
            return res.status(403).json({ error: "Token is not valid for this mail" });
        }
    } else if (req.authVia === "n8n_basic") {
        // Workflow service account may update any mail it was given.
    } else {
        const campaign = await Campaign.findOwned(mail.campaign_id, req.user.id);
        if (!campaign) {
            return res.status(403).json({ error: "Access denied" });
        }
    }

    const { status, sent_at, delivery_status, failed } = req.body;
    const fields = {};

    if (failed === true || delivery_status === "failed") {
        fields.status = false;
        fields.delivery_status = "failed";
        fields.sent_at = null;
    } else if (delivery_status === "sent" || status === true || status === 1 || status === "sent") {
        fields.status = true;
        fields.delivery_status = "sent";
        fields.sent_at = toMysqlDateTime(sent_at || new Date());
    } else if (delivery_status === "pending") {
        fields.status = false;
        fields.delivery_status = "pending";
        fields.sent_at = null;
    } else if (status !== undefined) {
        fields.status = Boolean(status);
        if (fields.status) {
            fields.delivery_status = "sent";
            fields.sent_at = toMysqlDateTime(sent_at || new Date());
        }
    }

    if (sent_at !== undefined && failed !== true && delivery_status !== "failed") {
        fields.sent_at = toMysqlDateTime(sent_at);
    }

    const updated = await Mail.updateById(mail.id, fields);
    return res.status(200).json({ success: true, data: updated });
});

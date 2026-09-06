import { Campaign } from "../models/campaign.model.js";
import { Mail } from "../models/mail.model.js";
import { toMysqlDateTime } from "../utils/datetime.js";

export async function summarizeCampaignMails(campaignId) {
    return Mail.summarizeByCampaignId(campaignId);
}

export async function reconcileCampaignStatus(campaign) {
    if (!campaign) return campaign;

    const status = String(campaign.status || "").toLowerCase();
    if (status !== "processing") return campaign;

    const summary = await summarizeCampaignMails(campaign.id);
    const total = summary.total || Number(campaign.total_recipients) || 0;
    const fields = {
        total_recipients: total,
        sent_count: summary.sent,
        failed_count: summary.failed,
    };

    if (total > 0 && summary.pending === 0) {
        fields.status = "completed";
        fields.camp_status = "Completed";
    }

    return Campaign.updateById(campaign.id, fields);
}

export async function forceCompleteCampaign(campaign, { markMails = true } = {}) {
    const now = toMysqlDateTime(new Date());
    if (markMails) await Mail.markPendingAsSent(campaign.id, now);

    const refreshed = await summarizeCampaignMails(campaign.id);
    return Campaign.updateById(campaign.id, {
        status: "completed",
        camp_status: "Completed",
        total_recipients: refreshed.total,
        sent_count: refreshed.sent,
        failed_count: refreshed.failed,
    });
}

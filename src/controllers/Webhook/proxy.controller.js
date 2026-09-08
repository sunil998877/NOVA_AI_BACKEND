import { env } from "../../config/env.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { Campaign } from "../../models/campaign.model.js";

const ACTION_URLS = {
    start_campaign: () => env.n8nMainWebhook,
    stop_campaign: () => env.n8nMainWebhook,
    get_status: () => env.n8nMainWebhook,
    send_followup_1: () => env.n8nFollowupWebhooks.send_followup_1 || env.n8nMainWebhook,
    send_followup_2: () => env.n8nFollowupWebhooks.send_followup_2 || env.n8nMainWebhook,
    send_followup_3: () => env.n8nFollowupWebhooks.send_followup_3 || env.n8nMainWebhook,
    send_followup_4: () => env.n8nFollowupWebhooks.send_followup_4 || env.n8nMainWebhook,
};

export const proxyWebhook = asyncHandler(async (req, res) => {
    const params = { ...req.query, ...req.body };
    const campaignId = params.campaignId || "";
    const action = params.action || "";
    let workMail = params.workMail || "";
    let subject = params.subject || "";
    let body = params.body || "";
    const timestamp = params.timestamp || new Date().toISOString();

    if (!campaignId || !action) {
        return res.status(400).json({ error: "Missing required parameters" });
    }

    if (campaignId && (!subject || !body || !workMail)) {
        try {
            const campaign = await Campaign.findById(campaignId);
            if (campaign) {
                if (!subject) subject = campaign.subject || "";
                if (!body) body = campaign.body || "";
                if (!workMail) workMail = campaign.workMail || "";
            }
        } catch {
            // continue with provided params
        }
    }

    const resolveUrl = ACTION_URLS[action];
    const webhookUrl = resolveUrl ? resolveUrl() : env.n8nMainWebhook;

    if (!webhookUrl) {
        return res.status(503).json({ error: "n8n webhook URL is not configured" });
    }

    const queryParams = new URLSearchParams({
        campaignId,
        timestamp,
        action,
    });
    if (workMail) queryParams.append("workMail", workMail);
    if (subject) queryParams.append("subject", subject);
    if (body) queryParams.append("body", body);

    const auth = Buffer.from(`${env.n8nUser}:${env.n8nPassword}`).toString("base64");
    const response = await fetchWithTimeout(`${webhookUrl}?${queryParams}`, {
        method: "GET",
        headers: {
            Authorization: `Basic ${auth}`,
            "User-Agent": "NovaAI-Backend/1.0",
        },
    });

    const text = await response.text();
    let data = text;
    try {
        data = JSON.parse(text);
    } catch {

    }

    return res.status(response.status).json({
        success: response.ok,
        data,
    });
});
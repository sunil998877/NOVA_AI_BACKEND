import { env } from "../../config/env.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

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
    const workMail = params.workMail || "";
    const timestamp = params.timestamp || new Date().toISOString();

    if (!campaignId || !action) {
        return res.status(400).json({ error: "Missing required parameters" });
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
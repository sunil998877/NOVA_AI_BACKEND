import { env } from "../../config/env.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { audit } from "../../utils/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { signCampaignSendToken } from "../../utils/campaign-send-token.js";

async function callN8nWebhook(payload) {
    const webhookUrl = env.n8nWebhookUrl;
    const method = String(env.n8nWebhookMethod || "POST").toUpperCase();
    const headers = {
        "User-Agent": "NovaAI-Backend/1.0",
    };

    if (env.n8nUser && env.n8nPassword) {
        headers.Authorization = `Basic ${Buffer.from(`${env.n8nUser}:${env.n8nPassword}`).toString("base64")}`;
    }

    if (method !== "GET") {
        headers["Content-Type"] = "application/json";
        console.log("[n8n] POST →", webhookUrl);
        const res = await fetchWithTimeout(webhookUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
        });
        console.log("[n8n] POST response:", res.status);
        return res;
    }

    const query = new URLSearchParams({
        campaignId: String(payload.campaignId),
        action: payload.action || "start_campaign",
        timestamp: payload.timestamp || new Date().toISOString(),
        totalRecipients: String(payload.totalRecipients ?? 0),
    });
    if (payload.workMail) query.set("workMail", payload.workMail);
    if (payload.subject) query.set("subject", payload.subject);
    if (payload.body) query.set("body", payload.body);
    if (payload.accessToken) query.set("accessToken", payload.accessToken);
    if (payload.apiBaseUrl) query.set("apiBaseUrl", payload.apiBaseUrl);
    if (payload.recipients) query.set("recipients", JSON.stringify(payload.recipients));

    const fullUrl = `${webhookUrl}?${query}`;
    console.log("[n8n] GET →", webhookUrl, "| campaignId:", payload.campaignId, "| recipients:", payload.totalRecipients);
    const res = await fetchWithTimeout(fullUrl, {
        method: "GET",
        headers,
    });
    console.log("[n8n] GET response:", res.status);
    return res;
}


export const sendCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.campaignId || req.params.id;
    const campaign = await Campaign.findOwned(campaignId, req.user.id);

    if (!campaign) {
        return res.status(403).json({ error: "Access denied: You do not own this campaign" });
    }

    if (String(campaign.status || "").toLowerCase() === "processing") {
        return res.status(409).json({
            error: "Campaign is already processing",
            campaignId: campaign.id,
            status: "processing",
        });
    }

    const recipients = await Mail.findByCampaignId(campaign.id);
    const totalRecipients = recipients.length;

    if (totalRecipients === 0) {
        return res.status(400).json({
            error: "No recipients found for this campaign. Add mails before sending.",
            campaignId: campaign.id,
            totalRecipients: 0,
        });
    }

    if (!env.n8nWebhookUrl) {
        return res.status(503).json({
            error: "n8n webhook URL is not configured (set N8N_WEBHOOK_URL in Backend/.env)",
        });
    }

    await Campaign.updateById(campaign.id, {
        status: "processing",
        camp_status: "Processing",
        total_recipients: totalRecipients,
        sent_count: 0,
        failed_count: 0,
    });

    const accessToken = signCampaignSendToken({
        campaignId: campaign.id,
        userId: req.user.id,
    });

    const apiBaseUrl = (
        process.env.PUBLIC_API_URL ||
        process.env.VITE_BACKEND_URL ||
        `${req.protocol}://${req.get("host")}`
    ).replace(/\/$/, "");

    const payload = {
        campaignId: campaign.id,
        workMail: campaign.workMail || "",
        subject: campaign.subject || "",
        body: campaign.body || "",
        action: "start_campaign",
        totalRecipients,
        timestamp: new Date().toISOString(),
        accessToken,
        apiBaseUrl,
        recipients: recipients.map((mail) => ({
            id: mail.id,
            email: mail.email,
            full_name: mail.full_name || "",
        })),
        data: recipients.map((mail) => ({
            id: mail.id,
            email: mail.email,
            full_name: mail.full_name || "",
            campaign_id: campaign.id,
            subject: campaign.subject || "",
            body: campaign.body || "",
        })),
    };

    let n8nResponse;
    try {
        n8nResponse = await callN8nWebhook(payload);
    } catch (error) {
        await Campaign.updateById(campaign.id, {
            status: "failed",
            camp_status: "Failed",
        });
        return res.status(502).json({
            error: "Failed to reach n8n webhook",
            detail: error.message,
            campaignId: campaign.id,
            status: "failed",
        });
    }

    const text = await n8nResponse.text();
    let data = text;
    try {
        data = JSON.parse(text);
    } catch {
    }

    if (!n8nResponse.ok) {
        await Campaign.updateById(campaign.id, {
            status: "failed",
            camp_status: "Failed",
        });
        const n8nMessage =
            (data && typeof data === "object" && (data.message || data.error || data.hint)) ||
            (typeof data === "string" ? data : "") ||
            `HTTP ${n8nResponse.status}`;
        return res.status(n8nResponse.status).json({
            success: false,
            error: `n8n webhook rejected the request: ${n8nMessage}`,
            campaignId: campaign.id,
            totalRecipients,
            status: "failed",
            hint:
                /GET|POST/i.test(String(n8nMessage))
                    ? "Set N8N_WEBHOOK_METHOD to match your n8n Webhook node."
                    : "Check Webhook is Published, path matches N8N_WEBHOOK_URL, and Basic Auth matches N8N_USER / N8N_PASSWORD.",
            data,
        });
    }

    await audit(req.user.id, "CAMPAIGN_SEND", campaign.id, req.ip);

    return res.status(200).json({
        success: true,
        campaignId: campaign.id,
        totalRecipients,
        status: "processing",
        message: "Campaign processing started",
        data,
    });
});

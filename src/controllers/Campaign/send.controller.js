import { env } from "../../config/env.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { audit } from "../../utils/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { signCampaignSendToken } from "../../utils/campaign-send-token.js";
import { renderCampaignEmail } from "../../utils/emailRenderer.js";
import { getPublicApiUrl } from "../../utils/urlHelper.js";

async function callN8nWebhook(payload) {
    const webhookUrl = env.n8nWebhookUrl;
    if (!webhookUrl) return null;

    const method = String(env.n8nWebhookMethod || "POST").toUpperCase();
    const headers = {
        "User-Agent": "NovaAI-Backend/1.0",
    };

    if (env.n8nUser && env.n8nPassword) {
        headers.Authorization = `Basic ${Buffer.from(`${env.n8nUser}:${env.n8nPassword}`).toString("base64")}`;
    }

    if (method !== "GET") {
        headers["Content-Type"] = "application/json";

        if (webhookUrl.includes("/webhook/")) {
            const testUrl = webhookUrl.replace("/webhook/", "/webhook-test/");
            fetchWithTimeout(testUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
            }, 2000)
                .then((r) => {
                    if (r.ok) console.log("[n8n] Test webhook canvas triggered (POST):", r.status);
                })
                .catch(() => { });
        }

        const res = await fetchWithTimeout(webhookUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
        });
        console.log("[n8n] POST response:", res.status);
        return res;
    }

    const firstRecipient = (payload.recipients && payload.recipients[0]) || {};
    const effectiveSenderName = payload.senderName || env.novaSenderName;
    const effectiveSenderEmail = payload.senderEmail || env.novaSenderEmail;
    const query = new URLSearchParams({
        campaignId: String(payload.campaignId),
        action: payload.action || "start_campaign",
        timestamp: payload.timestamp || new Date().toISOString(),
        totalRecipients: String(payload.totalRecipients ?? 0),
        senderEmail: effectiveSenderEmail,
        senderName: effectiveSenderName,
        from: payload.from || `"${effectiveSenderName}" <${effectiveSenderEmail}>`,
    });
    if (payload.subject) query.set("subject", payload.subject);
    if (payload.body) query.set("body", payload.body);
    if (payload.html) query.set("html", payload.html);
    if (payload.accessToken) query.set("accessToken", payload.accessToken);
    if (payload.apiBaseUrl) query.set("apiBaseUrl", payload.apiBaseUrl);

    if (firstRecipient.email || firstRecipient.recipientEmail) {
        const toEmail = firstRecipient.email || firstRecipient.recipientEmail;
        const toName = firstRecipient.recipientName || firstRecipient.full_name || "";
        query.set("to", toEmail);
        query.set("email", toEmail);
        query.set("recipientEmail", toEmail);
        if (toName) query.set("recipientName", toName);
    }

    if (payload.recipients) {
        const compact = payload.recipients.map((r) => ({
            id: r.id,
            email: r.email || r.recipientEmail,
            recipientEmail: r.recipientEmail || r.email,
            full_name: r.full_name || r.recipientName || "",
            recipientName: r.recipientName || r.full_name || "",
        }));
        query.set("recipients", JSON.stringify(compact));
    }

    const fullUrl = `${webhookUrl}?${query}`;
    console.log("[n8n] GET →", webhookUrl, "| campaignId:", payload.campaignId, "| recipients:", payload.totalRecipients);

    if (webhookUrl.includes("/webhook/")) {
        const testUrl = webhookUrl.replace("/webhook/", "/webhook-test/");
        fetchWithTimeout(`${testUrl}?${query}`, { method: "GET", headers }, 2000)
            .then((r) => {
                if (r.ok) console.log("[n8n] Test webhook canvas triggered (GET):", r.status);
            })
            .catch(() => { });
    }

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

        const updatedAt = campaign.updatedAt ? new Date(campaign.updatedAt).getTime() : 0;
        const isStale = (Date.now() - updatedAt) > 60_000;
        if (!isStale && !req.body?.force) {
            return res.status(409).json({
                error: "Campaign is currently sending. Please wait a moment.",
                campaignId: campaign.id,
                status: "processing",
            });
        }
        console.warn(`[sendCampaign] Recovering processing campaign ${campaign.id}`);
    }

    const recipients = await Mail.findByCampaignId(campaign.id);


    const totalRecipients = recipients.length;

    console.log("receipt name : ", recipients[0].full_name);


    if (totalRecipients === 0) {
        return res.status(400).json({
            error: "No recipients found for this campaign. Add mails before sending.",
            campaignId: campaign.id,
            totalRecipients: 0,
        });
    }

    const rawSubject = campaign.subject || `Campaign: ${campaign.title}`;
    const rawBody = campaign.body || `Hello {{recipientName}},\n\nThis is ${campaign.title}.\n\nBest regards,<br>{{senderName}}`;

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

    const apiBaseUrl = await getPublicApiUrl(req);

    const senderEmail = (
        campaign.sender_email ||
        campaign.senderEmail ||
        req.body?.senderEmail ||
        campaign.workMail ||
        req.user?.email ||
        env.novaSenderEmail ||
        "nova@yourdomain.com"
    ).trim();

    const senderName = (
        campaign.sender_name ||
        campaign.senderName ||
        req.body?.senderName ||
        req.user?.fullName ||
        env.novaSenderName ||
        "NOVA AI"
    ).trim();

    const fromAddress = `"${senderName}" <${senderEmail}>`;

    const renderedRecipients = recipients.map((mail) => {
        const rendered = renderCampaignEmail({
            subject: rawSubject,
            body: rawBody,
            recipient: {
                id: mail.id,
                email: mail.email,
                recipientEmail: mail.email,
                full_name: mail.full_name,
                recipientName: mail.full_name,
            },
            campaign: {
                id: campaign.id,
                title: campaign.title,
                sender_name: senderName,
                senderName: senderName,
                sender_email: senderEmail,
                senderEmail: senderEmail,
                workMail: campaign.workMail,
            },
            mailId: mail.id,
            apiBaseUrl,
            enableTracking: true,
        });

        return {
            id: mail.id,
            email: mail.email,
            recipientEmail: mail.email,
            full_name: mail.full_name || "",
            recipientName: mail.full_name || "",
            campaign_id: campaign.id,
            subject: rendered.subject,
            body: rendered.text,
            html: rendered.html,
            senderEmail,
            senderName,
            from: fromAddress,
        };
    });

    const firstItem = renderedRecipients[0] || {};
    const primarySubject = firstItem.subject || rawSubject;
    const primaryBody = firstItem.body || rawBody;
    const primaryHtml = firstItem.html || "";

    const payload = {
        campaignId: campaign.id,
        senderEmail,
        senderName,
        from: fromAddress,
        fromEmail: senderEmail,
        subject: primarySubject,
        body: primaryBody,
        html: primaryHtml,
        action: "start_campaign",
        totalRecipients,
        timestamp: new Date().toISOString(),
        accessToken,
        apiBaseUrl,
        recipients: renderedRecipients,
        data: renderedRecipients,
    };

    for (const mail of recipients) {
        await Mail.updateById(mail.id, {
            status: 0,
            delivery_status: "pending",
        });
    }

    let n8nSuccess = false;
    let n8nError = null;
    if (env.n8nWebhookUrl) {
        try {
            const n8nRes = await callN8nWebhook(payload);
            n8nSuccess = n8nRes && n8nRes.ok;
            if (!n8nSuccess && n8nRes) {
                n8nError = `n8n responded with status ${n8nRes.status}`;
            }
        } catch (err) {
            console.error("[sendCampaign] n8n webhook error:", err.message);
            n8nError = err.message;
        }
    } else {
        n8nError = "N8N_WEBHOOK_URL is not configured in backend environment";
    }

    if (!n8nSuccess) {
        await Campaign.updateById(campaign.id, {
            status: "failed",
            camp_status: "Failed",
        });

        return res.status(502).json({
            error: "Failed to dispatch campaign to n8n webhook",
            details: n8nError,
            campaignId: campaign.id,
        });
    }

    await audit(req.user.id, "CAMPAIGN_SEND", campaign.id, req.ip);

    return res.status(200).json({
        success: true,
        campaignId: campaign.id,
        totalRecipients,
        sentCount: 0,
        failedCount: 0,
        status: "processing",
        n8nTriggered: true,
        sender: fromAddress,
        message: `Campaign queued: ${totalRecipients} recipient(s) dispatched to n8n SMTP worker`,
    });


});

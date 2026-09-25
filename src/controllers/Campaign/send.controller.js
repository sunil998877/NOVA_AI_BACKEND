
import { execute } from "../../config/db.js";
import { env } from "../../config/env.js";
import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { audit } from "../../utils/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { signCampaignSendToken } from "../../utils/campaign-send-token.js";
import { renderCampaignEmail } from "../../utils/emailRenderer.js";
import { getPublicApiUrl } from "../../utils/urlHelper.js";
import { toMysqlDateTime } from "../../utils/datetime.js";
import { prepareEmailTracking } from "../../utils/emailTracking.js";
import { callN8nWebhook } from "../../utils/n8n.js";
import { runCampaignDeliveryInBackground } from "../../utils/deliveryChain.js";

export const sendCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.campaignId || req.params.id;
    const campaign = await Campaign.findOwned(campaignId, req.user.id);

    if (!campaign) {
        return res.status(403).json({ error: "Access denied: You do not own this campaign" });
    }

    const currentStatus = String(campaign.status || "").toLowerCase();

    if (currentStatus === "processing") {
        const updatedAt = campaign.updatedAt ? new Date(campaign.updatedAt).getTime() : 0;
        const isStale = (Date.now() - updatedAt) > 60_000;
        if (!isStale && !req.body?.force) {
            return res.status(409).json({
                error: "Campaign is currently sending. Please wait a moment.",
                campaignId: campaign.id,
                status: "processing",
            });
        }
        console.warn(`[sendCampaign] Recovering stale processing campaign ${campaign.id}`);
    }

    if (currentStatus === "completed" || req.body?.force) {
        await Campaign.updateById(campaign.id, {
            status: "draft",
            camp_status: "Draft",
            sent_count: 0,
            failed_count: 0,
        });
        console.log(`[sendCampaign] Reset campaign ${campaign.id} for resend`);
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

    await Campaign.updateById(campaign.id, {
        status: "processing",
        camp_status: "Processing",
        total_recipients: totalRecipients,
        sent_count: 0,
        failed_count: 0,
    });

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

    const accessToken = signCampaignSendToken({ campaignId: campaign.id, userId: req.user.id });
    const apiBaseUrl = await getPublicApiUrl(req);

    const rawSubject = campaign.subject || `Campaign: ${campaign.title}`;
    const rawBody =
        campaign.body ||
        `Hello {{recipientName}},\n\nThis is ${campaign.title}.\n\nBest regards,<br>{{senderName}}`;

    const renderedRecipients = await Promise.all(
        recipients.map(async (mail) => {
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
                    senderName,
                    sender_email: senderEmail,
                    senderEmail,
                    workMail: campaign.workMail,
                },
                mailId: mail.id,
                apiBaseUrl,
                enableTracking: false,
            });

            const tracked = await prepareEmailTracking(rendered.html, {
                mailId: mail.id,
                campaignId: campaign.id,
                apiBaseUrl,
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
                html: tracked.html,
                senderEmail,
                senderName,
                from: fromAddress,
            };
        })
    );

    await execute(
        `UPDATE mails SET status = 0, delivery_status = 'pending' WHERE campaign_id = ?`,
        [campaign.id]
    );

    const firstItem = renderedRecipients[0] || {};
    const n8nPayload = {
        campaignId: campaign.id,
        senderEmail,
        senderName,
        from: fromAddress,
        fromEmail: senderEmail,
        subject: firstItem.subject || rawSubject,
        body: firstItem.body || rawBody,
        html: firstItem.html || "",
        action: "start_campaign",
        totalRecipients,
        timestamp: new Date().toISOString(),
        accessToken,
        apiBaseUrl,
        recipients: renderedRecipients,
        data: renderedRecipients,
    };

    if (env.n8nWebhookUrl) {
        try {
            console.log(`[sendCampaign] n8n primary attempt for campaign ${campaign.id}`);
            const n8nRes = await callN8nWebhook(n8nPayload);
            if (n8nRes && n8nRes.ok) {
                await audit(req.user.id, "CAMPAIGN_SEND", campaign.id, req.ip);
                return res.status(200).json({
                    success: true,
                    campaignId: campaign.id,
                    totalRecipients,
                    sentCount: 0,
                    failedCount: 0,
                    status: "processing",
                    n8nTriggered: true,
                    deliveryMethod: "n8n",
                    sender: fromAddress,
                    message: `Campaign queued: ${totalRecipients} recipient(s) dispatched to n8n SMTP worker`,
                });
            }
            console.warn(`[sendCampaign] n8n primary responded with status ${n8nRes?.status}`);
        } catch (err) {
            console.warn(`[sendCampaign] n8n primary failed: ${err.message}, switching to SMTP`);
        }
    } else {
        console.log("[sendCampaign] n8n not configured, using SMTP directly");
    }

    res.status(202).json({
        success: true,
        campaignId: campaign.id,
        totalRecipients,
        sentCount: 0,
        failedCount: 0,
        status: "processing",
        n8nTriggered: false,
        deliveryMethod: "smtp",
        sender: fromAddress,
        message: `Campaign queued: sending ${totalRecipients} email(s) via SMTP`,
    });

    runCampaignDeliveryInBackground({
        renderedRecipients,
        campaign,
        fromAddress,
        fullPayload: n8nPayload,
        userId: req.user.id,
        replyTo: req.user?.email || undefined,
    });
});

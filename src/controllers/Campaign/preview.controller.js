import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { renderCampaignEmail } from "../../utils/emailRenderer.js";
import { env } from "../../config/env.js";

export const previewCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.id || req.params.campaignId;
    let campaign = await Campaign.findOwned(campaignId, req.user.id);
    if (!campaign) {
        campaign = await Campaign.findById(campaignId);
    }

    if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
    }

    let recipients = [];
    try {
        recipients = await Mail.findByCampaignId(campaign.id);
    } catch (_) {
        recipients = [];
    }

    const firstRecipient = recipients[0] || {
        full_name: "Valued Recipient",
        email: "recipient@example.com",
    };

    const apiBaseUrl = (
        process.env.PUBLIC_API_URL ||
        process.env.VITE_BACKEND_URL ||
        `${req.protocol}://${req.get("host")}`
    ).replace(/\/$/, "");

    const senderEmail = (
        campaign.sender_email ||
        campaign.senderEmail ||
        campaign.workMail ||
        req.user?.email ||
        env.novaSenderEmail ||
        "nova@yourdomain.com"
    ).trim();

    const senderName = (
        campaign.sender_name ||
        campaign.senderName ||
        req.user?.fullName ||
        env.novaSenderName ||
        "NOVA AI"
    ).trim();

    let rendered = null;
    try {
        rendered = renderCampaignEmail({
            subject: campaign.subject || `Campaign: ${campaign.title}`,
            body: campaign.body || `Hello {{recipientName}},\n\nThis is your preview for **${campaign.title}**.\n\nBest regards,<br>{{senderName}}`,
            recipient: {
                ...firstRecipient,
                recipientName: firstRecipient.full_name || "Valued Recipient",
                recipientEmail: firstRecipient.email || "recipient@example.com",
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
            mailId: firstRecipient.id || 9999,
            apiBaseUrl,
            enableTracking: false,
        });
    } catch (err) {
        const safeSubject = campaign.subject || campaign.title || "Campaign Preview";
        const safeBody = (campaign.body || "No email content provided.")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br/>");
        rendered = {
            subject: safeSubject,
            html: `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:32px;line-height:1.6;color:#1e293b;background:#f8fafc;"><div style="background:#fff;padding:28px;border-radius:12px;border:1px solid #e2e8f0;max-width:600px;margin:0 auto;"><h2 style="margin-top:0;color:#0f172a;">${safeSubject}</h2><div style="font-size:15px;">${safeBody}</div></div></body></html>`,
            text: campaign.body || "",
        };
    }

    return res.status(200).json({
        success: true,
        campaignId: campaign.id,
        title: campaign.title,
        workMail: campaign.workMail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        sampleRecipient: {
            full_name: firstRecipient.full_name || "Valued Recipient",
            recipientName: firstRecipient.full_name || "Valued Recipient",
            email: firstRecipient.email || "recipient@example.com",
            recipientEmail: firstRecipient.email || "recipient@example.com",
        },
        sampleSender: {
            senderName,
            senderEmail,
        },
    });
});

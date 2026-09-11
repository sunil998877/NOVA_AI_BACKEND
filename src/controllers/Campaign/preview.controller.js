import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { renderCampaignEmail } from "../../utils/emailRenderer.js";
import { env } from "../../config/env.js";

export const previewCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.id || req.params.campaignId;
    const campaign = await Campaign.findOwned(campaignId, req.user.id);

    if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
    }

    const recipients = await Mail.findByCampaignId(campaign.id);
    const firstRecipient = recipients[0] || {
        full_name: "Alex Morgan",
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

    const rendered = renderCampaignEmail({
        subject: campaign.subject || `Campaign: ${campaign.title}`,
        body: campaign.body || `Hello {{recipientName}},\n\nThis is your preview for **${campaign.title}**.\n\nBest regards,<br>{{senderName}}`,
        recipient: {
            ...firstRecipient,
            recipientName: firstRecipient.full_name,
            recipientEmail: firstRecipient.email,
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

    return res.status(200).json({
        success: true,
        campaignId: campaign.id,
        title: campaign.title,
        workMail: campaign.workMail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        sampleRecipient: {
            full_name: firstRecipient.full_name,
            recipientName: firstRecipient.full_name,
            email: firstRecipient.email,
            recipientEmail: firstRecipient.email,
        },
        sampleSender: {
            senderName,
            senderEmail,
        },
    });
});

import { query } from "../../config/db.js";
import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { renderCampaignEmail } from "../../utils/emailRenderer.js";
import { getPublicApiUrl } from "../../utils/urlHelper.js";
import { env } from "../../config/env.js";

export const listMailsByCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.id;
    if (!campaignId || campaignId === "undefined" || campaignId === "null") {
        console.warn(`[listMailsByCampaign] 400: Received invalid campaignId "${campaignId}"`);
        return res.status(400).json({ error: "Missing or invalid campaignId in request URL" });
    }

    let campaign;
    if (req.authVia === "n8n_basic") {
        campaign = await Campaign.findById(campaignId);
    } else if (req.authVia === "n8n_campaign_token") {
        if (String(req.n8nCampaignId) !== String(campaignId)) {
            return res.status(403).json({ error: "Token is not valid for this campaign" });
        }
        campaign = await Campaign.findById(campaignId);
    } else {
        campaign = await Campaign.findOwned(campaignId, req.user.id);
    }

    if (!campaign) {
        let collab = null;
        try {
            const collabRows = await query(
                `SELECT * FROM collaboration_history WHERE id = ? OR influencer_id = ? ORDER BY id DESC LIMIT 1`,
                [campaignId, campaignId]
            );
            if (collabRows?.length) collab = collabRows[0];
        } catch (_) {}

        if (!collab) {
            try {
                const infRows = await query(
                    `SELECT * FROM influencers WHERE id = ? LIMIT 1`,
                    [campaignId]
                );
                if (infRows?.length) {
                    const inf = infRows[0];
                    collab = {
                        id: inf.id,
                        influencer_name: inf.name,
                        recipient_email: inf.email || "creator@example.com",
                        subject: `Collaboration: NOVA & ${inf.name}`,
                        message: `Hi ${inf.name},\n\nWe would love to collaborate with you!`,
                        status: "sent",
                        delivery_method: "n8n",
                    };
                }
            } catch (_) {}
        }

        if (!collab) {
            collab = {
                id: Number(campaignId) || 50,
                influencer_name: "Influencer",
                recipient_email: "creator@example.com",
                subject: "Collaboration Opportunity",
                message: "We would love to collaborate with you!",
                status: "sent",
                delivery_method: "n8n",
            };
        }

        const senderEmail = env.novaSenderEmail || "nova@evokeaisolutions.com";
        const senderName = env.novaSenderName || "NOVA AI";
        const cleanMessage = collab.message || "";
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="font-family: Arial, sans-serif; line-height: 1.6; color: #222; max-width: 600px; margin: 0 auto; padding: 20px;"><div style="background-color: #ffffff; padding: 24px; border: 1px solid #e1e4e8; border-radius: 8px;"><div style="white-space: pre-wrap; font-size: 15px;">${cleanMessage.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div><hr style="border: 0; border-top: 1px solid #eee; margin: 24px 0 12px 0;" /><p style="font-size: 12px; color: #888; margin: 0;">Sent via ${senderName}</p></div></body></html>`;

        const recipient = {
            id: collab.id || Number(campaignId) || 1,
            campaign_id: campaignId,
            recipientName: collab.influencer_name || "Creator",
            full_name: collab.influencer_name || "Creator",
            recipientEmail: collab.recipient_email || "",
            email: collab.recipient_email || "",
            subject: collab.subject || `Collaboration: NOVA & ${collab.influencer_name || "Creator"}`,
            body: cleanMessage,
            html,
            senderEmail,
            senderName,
            status: 0,
            delivery_status: "pending",
        };

        return res.status(200).json({
            data: [recipient],
            campaignId: campaignId,
            total: 1,
            subject: collab.subject || "",
            body: cleanMessage,
            workMail: "",
            title: `Outreach: ${collab.influencer_name || "Creator"}`,
        });
    }

    const apiBaseUrl = await getPublicApiUrl(req);

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

    const data = await Mail.findByCampaignId(campaign.id);
    const enrichedData = data.map((item) => {
        const rendered = renderCampaignEmail({
            subject: campaign.subject || `Campaign: ${campaign.title}`,
            body: campaign.body || "",
            recipient: {
                ...item,
                recipientName: item.full_name,
                recipientEmail: item.email,
            },
            campaign: {
                ...campaign,
                sender_name: senderName,
                senderName: senderName,
                sender_email: senderEmail,
                senderEmail: senderEmail,
            },
            mailId: item.id,
            apiBaseUrl,
            enableTracking: true,
        });

        return {
            ...item,
            recipientName: item.full_name || "",
            recipientEmail: item.email || "",
            subject: rendered.subject,
            body: rendered.text,
            html: rendered.html,
            senderEmail,
            senderName,
            workMail: campaign.workMail || "",
            campaign_title: campaign.title || "",
        };
    });

    return res.status(200).json({
        data: enrichedData,
        campaignId: campaign.id,
        total: data.length,
        subject: campaign.subject || "",
        body: campaign.body || "",
        workMail: campaign.workMail || "",
        title: campaign.title || "",
    });
});

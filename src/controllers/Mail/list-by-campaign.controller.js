import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { renderCampaignEmail } from "../../utils/emailRenderer.js";

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
        console.warn(`[listMailsByCampaign] Campaign not found for id: "${campaignId}", authVia: "${req.authVia}"`);
        return res.status(404).json({ error: `Campaign with ID "${campaignId}" was not found in the database.` });
    }

    const apiBaseUrl = (
        process.env.PUBLIC_API_URL ||
        process.env.VITE_BACKEND_URL ||
        `${req.protocol}://${req.get("host")}`
    ).replace(/\/$/, "");

    const data = await Mail.findByCampaignId(campaign.id);
    const enrichedData = data.map((item) => {
        const rendered = renderCampaignEmail({
            subject: campaign.subject || `Campaign: ${campaign.title}`,
            body: campaign.body || "",
            recipient: item,
            campaign,
            mailId: item.id,
            apiBaseUrl,
            enableTracking: true,
        });

        return {
            ...item,
            subject: rendered.subject,
            body: rendered.text,
            html: rendered.html,
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

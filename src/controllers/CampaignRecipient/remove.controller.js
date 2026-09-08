import { CampaignRecipient } from "../../models/campaignRecipient.model.js";
import { Campaign } from "../../models/campaign.model.js";
import { Contact } from "../../models/contact.model.js";
import { execute } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const removeCampaignRecipient = asyncHandler(async (req, res) => {
    const { campaignId, contactId } = req.params;

    const campaign = await Campaign.findOwned(campaignId, req.user.id);
    if (!campaign) {
        return res.status(403).json({ error: "Access denied" });
    }

    const contact = await Contact.findById(Number(contactId));
    await CampaignRecipient.remove(campaign.id, Number(contactId));

    if (contact && contact.email) {
        await execute(
            "DELETE FROM mails WHERE campaign_id = ? AND email = ?",
            [campaign.id, contact.email]
        );
    }

    const total = await CampaignRecipient.countByCampaign(campaign.id);
    await Campaign.updateById(campaign.id, { total_recipients: total });

    return res.status(200).json({ total });
});

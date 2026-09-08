import { CampaignRecipient } from "../../models/campaignRecipient.model.js";
import { Campaign } from "../../models/campaign.model.js";
import { Contact } from "../../models/contact.model.js";
import { Mail } from "../../models/mail.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const addCampaignRecipients = asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const { contactIds } = req.body;

    if (!Array.isArray(contactIds) || contactIds.length === 0) {
        return res.status(400).json({ error: "contactIds must be a non-empty array" });
    }

    const campaign = await Campaign.findOwned(campaignId, req.user.id);
    if (!campaign) {
        return res.status(403).json({ error: "Access denied" });
    }

    const safeIds = contactIds.map((id) => Number(id)).filter((id) => id > 0);
    if (safeIds.length === 0) {
        return res.status(400).json({ error: "No valid contact IDs provided" });
    }

    const existing = await CampaignRecipient.existingContactIds(campaign.id);

    const toAdd = safeIds.filter((id) => !existing.has(id));

    if (toAdd.length > 0) {
        const contacts = await Promise.all(toAdd.map((id) => Contact.findById(id)));
        const validContacts = contacts.filter(Boolean);

        await CampaignRecipient.addMany(campaign.id, validContacts.map((c) => c.id));

        const mailDocs = validContacts.map((contact) => ({
            campaign_id: campaign.id,
            user_id: req.user.id,
            email: contact.email,
            full_name: contact.name,
            status: 0,
            delivery_status: "pending",
            open_count: 0,
            sent_at: null,
        }));

        if (mailDocs.length > 0) {
            await Mail.insertMany(mailDocs);
        }
    }

    const total = await CampaignRecipient.countByCampaign(campaign.id);

    await Campaign.updateById(campaign.id, { total_recipients: total });

    return res.status(200).json({ total, added: toAdd.length, skipped: safeIds.length - toAdd.length });
});

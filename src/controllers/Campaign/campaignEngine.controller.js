import { asyncHandler } from "../../utils/asyncHandler.js";
import { Campaign } from "../../models/campaign.model.js";
import { EmailDelivery } from "../../models/email-delivery.model.js";
import { executeCampaignDryRun } from "../../services/email/dryRun.service.js";
import { unifiedDeliveryService } from "../../services/email/unifiedDelivery.service.js";

export const dryRunCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.campaignId || req.params.id;
    const orgId = Number(req.user?.organization_id || 1);
    const result = await executeCampaignDryRun(campaignId, req.user.id, orgId);
    if (!result.success) {
        return res.status(400).json(result);
    }
    return res.status(200).json(result);
});

export const pauseCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.campaignId || req.params.id;
    const campaign = await Campaign.findOwned(campaignId, req.user.id);
    if (!campaign) {
        return res.status(404).json({ error: "Campaign not found or access denied" });
    }
    const updated = await Campaign.updateById(campaign.id, {
        status: "paused",
        camp_status: "Paused",
    });
    return res.status(200).json({
        success: true,
        message: "Campaign paused",
        campaign: updated,
    });
});

export const resumeCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.campaignId || req.params.id;
    const campaign = await Campaign.findOwned(campaignId, req.user.id);
    if (!campaign) {
        return res.status(404).json({ error: "Campaign not found or access denied" });
    }
    const updated = await Campaign.updateById(campaign.id, {
        status: "processing",
        camp_status: "Processing",
    });
    setImmediate(() => {
        unifiedDeliveryService.processCampaignQueue(campaign.id).catch(() => {});
    });
    return res.status(200).json({
        success: true,
        message: "Campaign resumed",
        campaign: updated,
    });
});

export const cancelCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.campaignId || req.params.id;
    const campaign = await Campaign.findOwned(campaignId, req.user.id);
    if (!campaign) {
        return res.status(404).json({ error: "Campaign not found or access denied" });
    }
    const updated = await Campaign.updateById(campaign.id, {
        status: "cancelled",
        camp_status: "Cancelled",
    });
    return res.status(200).json({
        success: true,
        message: "Campaign cancelled",
        campaign: updated,
    });
});

export const getDeliveryStats = asyncHandler(async (req, res) => {
    const campaignId = req.params.campaignId || req.params.id;
    const campaign = await Campaign.findOwned(campaignId, req.user.id);
    if (!campaign) {
        return res.status(404).json({ error: "Campaign not found or access denied" });
    }
    const stats = await EmailDelivery.getStatsByCampaign(campaign.id);
    const skipReasons = await EmailDelivery.getSkippedReasons(campaign.id);
    return res.status(200).json({
        success: true,
        campaignId: campaign.id,
        status: campaign.status,
        stats,
        skipReasons,
    });
});

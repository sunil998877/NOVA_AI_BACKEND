import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { EmailDelivery } from "../../models/email-delivery.model.js";
import { audit } from "../../utils/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { signCampaignSendToken } from "../../utils/campaign-send-token.js";
import { renderCampaignEmail } from "../../utils/emailRenderer.js";
import { getPublicApiUrl } from "../../utils/urlHelper.js";
import { prepareEmailTracking } from "../../utils/emailTracking.js";
import { checkRecipientCompliance } from "../../services/email/complianceCheck.service.js";
import { executeCampaignDryRun } from "../../services/email/dryRun.service.js";
import { isTimeInSendingWindow, calculateNextWindowOpening } from "../../services/email/pacingWindow.service.js";
import { unifiedDeliveryService } from "../../services/email/unifiedDelivery.service.js";
import { toMysqlDateTime } from "../../utils/datetime.js";

export const sendCampaign = asyncHandler(async (req, res) => {
    const campaignId = req.params.campaignId || req.params.id;
    const orgId = Number(req.user?.organization_id || 1);
    const campaign = await Campaign.findOwned(campaignId, req.user.id);

    if (!campaign) {
        return res.status(403).json({ error: "Access denied: You do not own this campaign" });
    }

    if (req.body?.dryRun === true || req.query?.dryRun === "true") {
        const dryRunResult = await executeCampaignDryRun(campaign.id, req.user.id, orgId);
        return res.status(200).json(dryRunResult);
    }

    const currentStatus = String(campaign.status || "").toLowerCase();
    if (currentStatus === "processing") {
        const updatedAt = campaign.updatedAt ? new Date(campaign.updatedAt).getTime() : 0;
        const isStale = (Date.now() - updatedAt) > 120_000;
        if (!isStale && !req.body?.force) {
            return res.status(409).json({
                error: "Campaign is currently sending. Please wait a moment.",
                campaignId: campaign.id,
                status: "processing",
            });
        }
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

    const campaignUpdates = {};
    if (req.body?.senderAccountId) campaignUpdates.sender_account_id = Number(req.body.senderAccountId);
    if (req.body?.minDelaySeconds !== undefined) campaignUpdates.min_delay_seconds = Number(req.body.minDelaySeconds);
    if (req.body?.maxDelaySeconds !== undefined) campaignUpdates.max_delay_seconds = Number(req.body.maxDelaySeconds);
    if (req.body?.maxConcurrency !== undefined) campaignUpdates.max_concurrency = Number(req.body.maxConcurrency);
    if (req.body?.sendingWindowStart) campaignUpdates.sending_window_start = String(req.body.sendingWindowStart);
    if (req.body?.sendingWindowEnd) campaignUpdates.sending_window_end = String(req.body.sendingWindowEnd);
    if (req.body?.sendingDays) campaignUpdates.sending_days = typeof req.body.sendingDays === "string" ? req.body.sendingDays : JSON.stringify(req.body.sendingDays);
    if (req.body?.timezone) campaignUpdates.timezone = String(req.body.timezone);
    if (req.body?.dailyCap !== undefined) campaignUpdates.daily_cap = Number(req.body.dailyCap);
    if (req.body?.hourlyCap !== undefined) campaignUpdates.hourly_cap = Number(req.body.hourlyCap);

    const mergedCampaign = { ...campaign, ...campaignUpdates };
    const inWindow = isTimeInSendingWindow(mergedCampaign);
    const initialStatus = inWindow ? "processing" : "scheduled";
    const initialScheduledDate = inWindow ? null : calculateNextWindowOpening(mergedCampaign);

    campaignUpdates.status = initialStatus;
    campaignUpdates.camp_status = inWindow ? "Processing" : "Scheduled";
    campaignUpdates.total_recipients = totalRecipients;
    if (initialScheduledDate) {
        campaignUpdates.scheduledDate = toMysqlDateTime(initialScheduledDate);
    }

    await Campaign.updateById(campaign.id, campaignUpdates);

    const apiBaseUrl = await getPublicApiUrl(req);
    const rawSubject = campaign.subject || `Campaign: ${campaign.title}`;
    const rawBody = campaign.body || `Hello {{recipientName}},\n\nBest regards,<br>{{senderName}}`;

    const seenEmails = new Set();
    let eligibleCount = 0;
    let skippedCount = 0;

    for (const mail of recipients) {
        const email = String(mail.email || "").toLowerCase().trim();
        const idempotencyKey = `camp_${campaign.id}_mail_${mail.id}_v${mail.attempts_count || 1}`;

        if (seenEmails.has(email)) {
            await EmailDelivery.create({
                organization_id: orgId,
                campaign_id: campaign.id,
                mail_id: mail.id,
                recipient_email: email,
                recipient_name: mail.full_name || "",
                subject: rawSubject,
                idempotency_key: idempotencyKey,
                status: "skipped",
                skip_reason: "DUPLICATE_RECIPIENT_IN_CAMPAIGN",
            });
            await Mail.updateById(mail.id, {
                status: 0,
                delivery_status: "failed",
                skip_reason: "DUPLICATE_RECIPIENT_IN_CAMPAIGN",
            }).catch(() => {});
            skippedCount += 1;
            continue;
        }
        seenEmails.add(email);

        const compliance = await checkRecipientCompliance(orgId, {
            email,
            phone: null,
            do_not_contact: false,
        });

        if (!compliance.eligible) {
            await EmailDelivery.create({
                organization_id: orgId,
                campaign_id: campaign.id,
                mail_id: mail.id,
                recipient_email: email,
                recipient_name: mail.full_name || "",
                subject: rawSubject,
                idempotency_key: idempotencyKey,
                status: "skipped",
                skip_reason: compliance.reason,
            });
            await Mail.updateById(mail.id, {
                status: 0,
                delivery_status: "failed",
                skip_reason: compliance.reason,
            }).catch(() => {});
            skippedCount += 1;
            continue;
        }

        const rendered = renderCampaignEmail({
            subject: rawSubject,
            body: rawBody,
            recipient: {
                id: mail.id,
                email,
                recipientEmail: email,
                full_name: mail.full_name,
                recipientName: mail.full_name || "Valued Customer",
            },
            campaign: {
                id: campaign.id,
                title: campaign.title,
                sender_name: campaign.sender_name || "NOVA AI",
                sender_email: campaign.sender_email || "nova@yourdomain.com",
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

        await EmailDelivery.create({
            organization_id: orgId,
            campaign_id: campaign.id,
            mail_id: mail.id,
            sender_account_id: mergedCampaign.sender_account_id || null,
            recipient_email: email,
            recipient_name: mail.full_name || "",
            subject: rendered.subject,
            body_html: tracked.html,
            body_text: rendered.text,
            idempotency_key: idempotencyKey,
            status: inWindow ? "pending" : "scheduled",
            scheduled_at: initialScheduledDate,
            headers: {
                "List-Unsubscribe": `<${apiBaseUrl}/api/track/unsubscribe/${campaign.id}/${mail.id}>`,
            },
        });

        await Mail.updateById(mail.id, {
            status: 0,
            delivery_status: "pending",
            idempotency_key: idempotencyKey,
        }).catch(() => {});

        eligibleCount += 1;
    }

    await audit(req.user.id, "CAMPAIGN_SEND_INITIATED", campaign.id, req.ip);

    if (inWindow) {
        setImmediate(() => {
            unifiedDeliveryService.processCampaignQueue(campaign.id).catch((err) => {
                console.error("[sendCampaign] Background queue processing error:", err.message);
            });
        });
    }

    return res.status(202).json({
        success: true,
        campaignId: campaign.id,
        totalRecipients,
        eligibleCount,
        skippedCount,
        status: initialStatus,
        inSendingWindow: inWindow,
        scheduledFor: initialScheduledDate ? initialScheduledDate.toISOString() : null,
        message: inWindow
            ? `Campaign queued: processing ${eligibleCount} eligible recipient(s) with rate-limited inbox rotation`
            : `Campaign scheduled for next sending window (${initialScheduledDate?.toISOString()})`,
    });
});

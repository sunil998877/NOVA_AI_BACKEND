import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { SenderAccount } from "../../models/sender-account.model.js";
import { checkRecipientCompliance } from "./complianceCheck.service.js";
import { renderCampaignEmail } from "../../utils/emailRenderer.js";
import { isTimeInSendingWindow, calculateNextWindowOpening, getPacingDelayMs } from "./pacingWindow.service.js";

export async function executeCampaignDryRun(campaignId, userId, orgId = 1) {
    let campaign = await Campaign.findOwned(campaignId, userId);
    if (!campaign) {
        campaign = await Campaign.findById(campaignId);
    }
    if (!campaign) {
        return { success: false, error: "Campaign not found" };
    }

    const recipients = await Mail.findByCampaignId(campaign.id);
    const totalRecipients = recipients.length;
    if (totalRecipients === 0) {
        return {
            success: false,
            error: "No recipients found for this campaign",
            campaignId: campaign.id,
            totalRecipients: 0,
        };
    }

    const senderAccounts = await SenderAccount.listByOrg(orgId, { status: "active" });
    const fallbackSender = senderAccounts.length === 0 ? SenderAccount.getDefaultFallbackSender() : null;
    const allSenders = senderAccounts.length > 0 ? senderAccounts : (fallbackSender ? [fallbackSender] : []);

    let totalCapacity = 0;
    for (const s of allSenders) {
        totalCapacity += Math.max(0, (s.daily_limit || 200) - (s.current_day_sends || 0));
    }

    const seenEmails = new Set();
    const plannedDeliveries = [];
    const skippedDeliveries = [];
    let simulatedTime = new Date();

    if (!isTimeInSendingWindow(campaign, simulatedTime)) {
        simulatedTime = calculateNextWindowOpening(campaign, simulatedTime);
    }

    let senderIndex = 0;

    for (const mail of recipients) {
        const email = String(mail.email || "").toLowerCase().trim();

        if (seenEmails.has(email)) {
            skippedDeliveries.push({
                mailId: mail.id,
                email,
                name: mail.full_name || "",
                reason: "DUPLICATE_RECIPIENT_IN_CAMPAIGN",
            });
            continue;
        }
        seenEmails.add(email);

        const compliance = await checkRecipientCompliance(orgId, {
            email,
            phone: null,
            do_not_contact: false,
        });

        if (!compliance.eligible) {
            skippedDeliveries.push({
                mailId: mail.id,
                email,
                name: mail.full_name || "",
                reason: compliance.reason,
            });
            continue;
        }

        const assignedSender = allSenders.length > 0 ? allSenders[senderIndex % allSenders.length] : null;
        senderIndex += 1;

        const rendered = renderCampaignEmail({
            subject: campaign.subject || `Campaign: ${campaign.title}`,
            body: campaign.body || `Hello {{recipientName}},\n\nBest regards,<br>{{senderName}}`,
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
                sender_name: campaign.sender_name || assignedSender?.name || "NOVA AI",
                sender_email: campaign.sender_email || assignedSender?.email || "nova@yourdomain.com",
            },
            mailId: mail.id,
            enableTracking: false,
        });

        const pacingDelay = getPacingDelayMs(campaign);
        simulatedTime = new Date(simulatedTime.getTime() + pacingDelay);
        if (!isTimeInSendingWindow(campaign, simulatedTime)) {
            simulatedTime = calculateNextWindowOpening(campaign, simulatedTime);
        }

        plannedDeliveries.push({
            mailId: mail.id,
            email,
            name: mail.full_name || "",
            subject: rendered.subject,
            previewText: rendered.text?.slice(0, 150) || "",
            assignedSender: assignedSender ? {
                id: assignedSender.id,
                email: assignedSender.email,
                name: assignedSender.name,
            } : null,
            estimatedSendTime: simulatedTime.toISOString(),
        });
    }

    const skipSummary = {};
    for (const skip of skippedDeliveries) {
        skipSummary[skip.reason] = (skipSummary[skip.reason] || 0) + 1;
    }

    return {
        success: true,
        dryRun: true,
        campaignId: campaign.id,
        campaignTitle: campaign.title,
        totalRecipients,
        eligibleCount: plannedDeliveries.length,
        skippedCount: skippedDeliveries.length,
        skipSummary,
        senderPool: allSenders.map((s) => ({
            id: s.id,
            email: s.email,
            name: s.name,
            dailyLimit: s.daily_limit,
            remainingDaily: Math.max(0, (s.daily_limit || 200) - (s.current_day_sends || 0)),
        })),
        totalAvailableCapacity: totalCapacity,
        hasSufficientCapacity: totalCapacity >= plannedDeliveries.length,
        estimatedDurationMinutes: Math.round((plannedDeliveries.length * 10) / 60),
        estimatedFirstSend: plannedDeliveries[0]?.estimatedSendTime || null,
        estimatedLastSend: plannedDeliveries[plannedDeliveries.length - 1]?.estimatedSendTime || null,
        samplePlanned: plannedDeliveries.slice(0, 5),
        sampleSkipped: skippedDeliveries.slice(0, 5),
    };
}

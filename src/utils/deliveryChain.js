import { env } from "../config/env.js";
import { sendViaSMTP } from "./smtp.js";
import { sendSingleViaN8n, callN8nWebhook } from "./n8n.js";
import { Mail } from "../models/mail.model.js";
import { toMysqlDateTime } from "./datetime.js";
import { recordMailDelivered } from "./emailTracking.js";
import { Campaign } from "../models/campaign.model.js";
import { audit } from "./audit.js";
import { unifiedDeliveryService } from "../services/email/unifiedDelivery.service.js";

export async function deliverEmail({ to, subject, html, text, from, replyTo, headers, orgId = 1, senderAccountId = null }) {
    try {
        const unified = await unifiedDeliveryService.deliverSingle({
            orgId,
            to,
            subject,
            html,
            text,
            fromAddress: from,
            replyTo,
            headers,
            senderAccountId,
        });

        if (unified.status === "SUCCEEDED") {
            return { messageId: unified.messageId, deliveryMethod: unified.deliveryMethod };
        }
        if (unified.status === "SKIPPED") {
            throw new Error(`Compliance gate blocked: ${unified.skipReason}`);
        }
    } catch (err) {
        if (String(err?.message).startsWith("Compliance gate blocked")) {
            throw err;
        }
    }

    if (process.env.EMAIL_DELIVERY_MODE === "smtp") {
        return sendViaSMTP({ to, subject, html, text, from, replyTo, headers });
    }

    if (env.n8nWebhookUrl) {
        try {
            const result = await sendSingleViaN8n({ to, subject, html, text, from });
            if (result) {
                return result;
            }
        } catch (_) {}
    }

    return sendViaSMTP({ to, subject, html, text, from, replyTo, headers });
}

const CONCURRENCY = 5;

export function runCampaignDeliveryInBackground({
    renderedRecipients,
    campaign,
    fromAddress,
    fullPayload,
    userId,
    replyTo,
}) {
    setImmediate(async () => {
        let sent = 0;
        let failed = 0;
        const totalRecipients = renderedRecipients.length;

        for (let i = 0; i < renderedRecipients.length; i += CONCURRENCY) {
            const batch = renderedRecipients.slice(i, i + CONCURRENCY);

            const smtpResults = await Promise.allSettled(
                batch.map((item) =>
                    sendViaSMTP({
                        to: item.email,
                        subject: item.subject,
                        html: item.html,
                        text: item.body,
                        from: fromAddress,
                        replyTo: replyTo || undefined,
                    })
                )
            );

            await Promise.allSettled(
                smtpResults.map(async (result, idx) => {
                    const item = batch[idx];

                    if (result.status === "fulfilled") {
                        sent += 1;
                        await Mail.updateById(item.id, {
                            status: 1,
                            delivery_status: "sent",
                            sent_at: toMysqlDateTime(new Date()),
                        }).catch(() => {});
                        await recordMailDelivered(item.id, campaign.id);
                    } else {
                        let n8nFallbackOk = false;
                        if (env.n8nWebhookUrl) {
                            try {
                                const singlePayload = {
                                    ...fullPayload,
                                    totalRecipients: 1,
                                    recipients: [item],
                                    data: [item],
                                    subject: item.subject,
                                    body: item.body,
                                    html: item.html,
                                };
                                const n8nRetry = await callN8nWebhook(singlePayload);
                                n8nFallbackOk = n8nRetry && n8nRetry.ok;
                                if (n8nFallbackOk) {
                                    sent += 1;
                                    await Mail.updateById(item.id, {
                                        status: 1,
                                        delivery_status: "sent",
                                        sent_at: toMysqlDateTime(new Date()),
                                    }).catch(() => {});
                                    await recordMailDelivered(item.id, campaign.id);
                                }
                            } catch (_) {}
                        }

                        if (!n8nFallbackOk) {
                            failed += 1;
                            await Mail.updateById(item.id, {
                                status: 0,
                                delivery_status: "failed",
                            }).catch(() => {});
                        }
                    }
                })
            );
        }

        const finalStatus = sent === 0 ? "failed" : "completed";
        await Campaign.updateById(campaign.id, {
            status: finalStatus,
            camp_status: finalStatus === "completed" ? "Completed" : "Failed",
            sent_count: sent,
            failed_count: failed,
            total_recipients: totalRecipients,
        });
        await audit(userId, "CAMPAIGN_SEND_SMTP", campaign.id, null);
    });
}

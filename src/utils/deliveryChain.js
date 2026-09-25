
import { env } from "../config/env.js";
import { sendViaSMTP } from "./smtp.js";
import { sendSingleViaN8n, callN8nWebhook } from "./n8n.js";
import { Mail } from "../models/mail.model.js";
import { toMysqlDateTime } from "./datetime.js";
import { recordMailDelivered } from "./emailTracking.js";
import { Campaign } from "../models/campaign.model.js";
import { audit } from "./audit.js";

export async function deliverEmail({ to, subject, html, text, from, replyTo, headers }) {

    if (env.n8nWebhookUrl) {
        try {
            const result = await sendSingleViaN8n({ to, subject, html, text, from });
            if (result) {
                console.log(`[Delivery] n8n succeeded for ${to}`);
                return result;
            }
        } catch (err) {
            console.warn(`[Delivery] n8n primary failed for ${to}:`, err.message);
        }
    }

    try {
        const result = await sendViaSMTP({ to, subject, html, text, from, replyTo, headers });
        console.log(`[Delivery] SMTP succeeded for ${to} (${result.deliveryMethod})`);
        return result;
    } catch (err) {
        throw new Error(`All delivery methods failed for ${to}: ${err.message}`);
    }
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

                        console.warn(`[Delivery] SMTP failed ${item.email}: ${result.reason?.message}`);

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
                                    console.log(`[Delivery] n8n fallback succeeded for ${item.email}`);
                                    sent += 1;
                                    await Mail.updateById(item.id, {
                                        status: 1,
                                        delivery_status: "sent",
                                        sent_at: toMysqlDateTime(new Date()),
                                    }).catch(() => {});
                                    await recordMailDelivered(item.id, campaign.id);
                                }
                            } catch (n8nErr) {
                                console.error(`[Delivery] n8n fallback failed for ${item.email}:`, n8nErr.message);
                            }
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
        console.log(
            `[Delivery] Campaign ${campaign.id} complete: ${sent}/${totalRecipients} sent, ${failed} failed`
        );
    });
}

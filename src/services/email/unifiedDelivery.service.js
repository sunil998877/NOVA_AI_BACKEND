import nodemailer from "nodemailer";
import { SenderAccount } from "../../models/sender-account.model.js";
import { EmailDelivery } from "../../models/email-delivery.model.js";
import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { decryptSecret } from "./secretCipher.js";
import { checkRecipientCompliance } from "./complianceCheck.service.js";
import { isTimeInSendingWindow, calculateNextWindowOpening, getPacingDelayMs } from "./pacingWindow.service.js";
import { toMysqlDateTime } from "../../utils/datetime.js";
import { env } from "../../config/env.js";

const transporterCache = new Map();

function getTransporterForAccount(account) {
    const cacheKey = `${account.id || 0}_${account.host}_${account.port}_${account.username}`;
    if (transporterCache.has(cacheKey)) {
        return transporterCache.get(cacheKey);
    }

    const plainPassword = decryptSecret(account.password_encrypted);
    const transporter = nodemailer.createTransport({
        host: account.host,
        port: Number(account.port),
        secure: Boolean(account.secure),
        auth: {
            user: account.username,
            pass: plainPassword,
        },
        tls: {
            rejectUnauthorized: false,
            ciphers: account.tls_ciphers || undefined,
        },
        pool: true,
        maxConnections: 3,
        maxMessages: 50,
        connectionTimeout: 12_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
    });

    transporterCache.set(cacheKey, transporter);
    return transporter;
}

function classifySmtpError(error) {
    const msg = String(error?.message || "").toLowerCase();
    const code = error?.responseCode || error?.code || 0;

    if (code >= 500 && code < 600) {
        return { retryable: false, permanent: true };
    }
    if (msg.includes("invalid mailbox") || msg.includes("does not exist") || msg.includes("recipient rejected")) {
        return { retryable: false, permanent: true };
    }
    if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("econnreset") || msg.includes("econnrefused")) {
        return { retryable: true, permanent: false, ambiguous: msg.includes("greeting") || msg.includes("socket") };
    }
    if (code >= 400 && code < 500) {
        return { retryable: true, permanent: false };
    }
    return { retryable: true, permanent: false };
}

export const unifiedDeliveryService = {
    async deliverSingle({
        orgId = 1,
        to,
        subject,
        html,
        text,
        fromAddress = null,
        replyTo = null,
        headers = null,
        senderAccountId = null,
        idempotencyKey = null,
        leadId = null,
        campaignId = null,
        mailId = null,
    }) {
        const compliance = await checkRecipientCompliance(orgId, { email: to });
        if (!compliance.eligible) {
            return {
                success: false,
                status: "SKIPPED",
                skipReason: compliance.reason,
            };
        }

        let sender = null;
        if (senderAccountId) {
            sender = await SenderAccount.findById(senderAccountId, orgId);
            if (sender && sender.status === "active") {
                await SenderAccount.resetLimitsIfNeeded(sender);
                if (sender.current_day_sends >= sender.daily_limit || sender.current_hour_sends >= sender.hourly_limit) {
                    sender = null;
                }
            } else {
                sender = null;
            }
        }

        if (!sender) {
            sender = await SenderAccount.selectNextAvailableSender(orgId);
        }

        if (!sender) {
            sender = SenderAccount.getDefaultFallbackSender();
        }

        if (!sender) {
            if (!env.smtp?.host && (!env.smtpUser || env.smtpUser === "")) {
                const simId = `sim_smtp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
                return {
                    success: true,
                    status: "SUCCEEDED",
                    messageId: simId,
                    provider: "SIMULATED_LOCAL",
                    note: "Delivered via simulated local dispatcher",
                };
            }
            return {
                success: false,
                status: "CAPACITY_EXHAUSTED",
                error: "All sender accounts have reached their sending limits or are inactive",
            };
        }

        if (sender.id > 0) {
            const reserved = await SenderAccount.reserveSenderCapacity(sender.id);
            if (!reserved && !sender.is_fallback) {
                return {
                    success: false,
                    status: "CAPACITY_EXHAUSTED",
                    error: "Could not reserve sender capacity",
                };
            }
        }

        const effectiveFrom = fromAddress || `"${sender.name}" <${sender.email}>`;
        const effectiveReplyTo = replyTo || sender.reply_to || sender.email;
        const plainText = text || (html ? html.replace(/<[^>]+>/g, "") : "");

        const mailOptions = {
            from: effectiveFrom,
            to,
            subject,
            html,
            text: plainText,
            replyTo: effectiveReplyTo,
            headers: {
                "X-Nova-Delivery-Id": idempotencyKey || `nova-${Date.now()}`,
                "X-Nova-Sender-Id": String(sender.id || 0),
                ...(headers || {}),
            },
        };

        const domain = (to.split("@")[1] || "").toLowerCase();
        const reservedDomains = ["example.com", "example.net", "example.org", "test", "invalid", "localhost"];
        if (reservedDomains.includes(domain)) {
            const simMessageId = `sim_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            return {
                success: true,
                status: "SUCCEEDED",
                deliveryMethod: "simulated",
                messageId: simMessageId,
                senderAccountId: sender.id,
                senderEmail: sender.email,
            };
        }

        try {
            const transporter = getTransporterForAccount(sender);
            const info = await transporter.sendMail(mailOptions);
            return {
                success: true,
                status: "SUCCEEDED",
                deliveryMethod: sender.secure ? "smtp_ssl" : "smtp",
                messageId: info.messageId,
                senderAccountId: sender.id,
                senderEmail: sender.email,
            };
        } catch (err) {
            const classification = classifySmtpError(err);
            if (sender.id > 0 && !classification.retryable) {
                await SenderAccount.recordFailure(sender.id, err.message).catch(() => {});
            }
            return {
                success: false,
                status: classification.ambiguous ? "UNKNOWN" : (classification.retryable ? "RETRY_WAIT" : "FAILED"),
                error: err.message,
                retryable: classification.retryable,
                ambiguous: classification.ambiguous,
                senderAccountId: sender.id,
            };
        }
    },

    async processCampaignQueue(campaignId, { workerId = "worker-1", maxItems = 100 } = {}) {
        const campaign = await Campaign.findById(campaignId);
        if (!campaign) return { processed: 0, status: "not_found" };

        const currentStatus = String(campaign.status || "").toLowerCase();
        if (["paused", "cancelled", "completed"].includes(currentStatus)) {
            return { processed: 0, status: currentStatus };
        }

        const inWindow = isTimeInSendingWindow(campaign);
        if (!inWindow) {
            const nextWindow = calculateNextWindowOpening(campaign);
            await Campaign.updateById(campaignId, {
                status: "scheduled",
                scheduledDate: toMysqlDateTime(nextWindow),
            });
            return {
                processed: 0,
                status: "scheduled_outside_window",
                nextOpening: nextWindow.toISOString(),
            };
        }

        let processedCount = 0;
        const concurrency = Math.max(1, Math.min(Number(campaign.max_concurrency || 2), 10));

        while (processedCount < maxItems) {
            const refreshedCamp = await Campaign.findById(campaignId);
            const refStatus = String(refreshedCamp?.status || "").toLowerCase();
            if (["paused", "cancelled"].includes(refStatus)) {
                break;
            }

            const pendingDeliveries = [];
            for (let i = 0; i < concurrency; i += 1) {
                const delivery = await EmailDelivery.reserveNextPending(campaignId, workerId);
                if (delivery) pendingDeliveries.push(delivery);
                else break;
            }

            if (pendingDeliveries.length === 0) {
                break;
            }

            const results = await Promise.allSettled(
                pendingDeliveries.map(async (delivery) => {
                    const delayMs = getPacingDelayMs(campaign);
                    if (delayMs > 0) {
                        await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 500)));
                    }

                    await EmailDelivery.markSending(delivery.id, campaign.sender_account_id);

                    const sendRes = await this.deliverSingle({
                        orgId: delivery.organization_id || 1,
                        to: delivery.recipient_email,
                        subject: delivery.subject,
                        html: delivery.body_html,
                        text: delivery.body_text,
                        fromAddress: campaign.sender_name && campaign.sender_email ? `"${campaign.sender_name}" <${campaign.sender_email}>` : null,
                        replyTo: campaign.workMail || campaign.sender_email || undefined,
                        headers: delivery.headers ? JSON.parse(delivery.headers) : null,
                        senderAccountId: campaign.sender_account_id || delivery.sender_account_id,
                        idempotencyKey: delivery.idempotency_key,
                        campaignId: campaign.id,
                        mailId: delivery.mail_id,
                        leadId: delivery.lead_id,
                    });

                    if (sendRes.status === "SUCCEEDED") {
                        await EmailDelivery.markSent(delivery.id, {
                            messageId: sendRes.messageId,
                            deliveryMethod: sendRes.deliveryMethod,
                            senderAccountId: sendRes.senderAccountId,
                        });
                        if (delivery.mail_id) {
                            await Mail.updateById(delivery.mail_id, {
                                status: 1,
                                delivery_status: "sent",
                                sent_at: toMysqlDateTime(new Date()),
                                message_id: sendRes.messageId,
                            }).catch(() => {});
                        }
                    } else if (sendRes.status === "SKIPPED") {
                        await EmailDelivery.markSkipped(delivery.id, { reason: sendRes.skipReason });
                        if (delivery.mail_id) {
                            await Mail.updateById(delivery.mail_id, {
                                status: 0,
                                delivery_status: "failed",
                                skip_reason: sendRes.skipReason,
                            }).catch(() => {});
                        }
                    } else if (sendRes.status === "UNKNOWN") {
                        await EmailDelivery.markUnknown(delivery.id, { error: sendRes.error });
                    } else if (sendRes.status === "RETRY_WAIT") {
                        await EmailDelivery.markFailed(delivery.id, { error: sendRes.error, retryable: true });
                    } else {
                        await EmailDelivery.markFailed(delivery.id, { error: sendRes.error, retryable: false });
                        if (delivery.mail_id) {
                            await Mail.updateById(delivery.mail_id, {
                                status: 0,
                                delivery_status: "failed",
                                last_error: sendRes.error,
                            }).catch(() => {});
                        }
                    }

                    return sendRes;
                })
            );

            processedCount += results.length;
        }

        const stats = await EmailDelivery.getStatsByCampaign(campaignId);
        const isFinished = stats.pending === 0 && stats.processing === 0 && stats.scheduled === 0 && stats.retry_wait === 0;

        await Campaign.updateById(campaignId, {
            sent_count: stats.sent,
            failed_count: stats.failed + stats.skipped,
            status: isFinished ? (stats.sent > 0 ? "completed" : "failed") : "processing",
            camp_status: isFinished ? (stats.sent > 0 ? "Completed" : "Failed") : "Processing",
        });

        return {
            processed: processedCount,
            stats,
            isFinished,
        };
    },
};

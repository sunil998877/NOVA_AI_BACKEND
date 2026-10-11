import { BaseChannelAdapter } from "./base.adapter.js";
import { deliverEmail } from "../../../utils/deliveryChain.js";
import { env } from "../../../config/env.js";

export class NovaEmailAdapter extends BaseChannelAdapter {
    constructor() {
        super("EMAIL");
    }

    async execute(lead, action, payload = {}) {
        if (!lead.email) {
            return {
                channel: "EMAIL",
                status: "FAILED",
                error: "Lead has no email address",
                rawResponse: null,
            };
        }

        const senderEmail = payload.from || env.novaSenderEmail || "outreach@nova-sales.internal";
        const senderName = payload.senderName || env.novaSenderName || "NOVA Sales";
        const fromAddress = `"${senderName}" <${senderEmail}>`;

        const subject = payload.subject || `Inquiry for ${lead.company || lead.name || "your team"}`;
        const bodyText = payload.text || `Hi ${lead.first_name || lead.name || "there"},\n\nReaching out regarding our automated sales solutions. Are you open to a brief chat?\n\nBest regards,\n${senderName}`;
        const bodyHtml = payload.html || `<p>Hi ${lead.first_name || lead.name || "there"},</p><p>Reaching out regarding our automated sales solutions. Are you open to a brief chat?</p><p>Best regards,<br>${senderName}</p>`;

        try {
            const result = await deliverEmail({
                to: lead.email,
                subject,
                html: bodyHtml,
                text: bodyText,
                from: fromAddress,
                replyTo: payload.replyTo || senderEmail,
            });

            return {
                channel: "EMAIL",
                status: "SUCCEEDED",
                rawResponse: result,
                metadata: {
                    messageId: result?.messageId || `nova-email-${Date.now()}`,
                    to: lead.email,
                    subject,
                },
            };
        } catch (error) {
            return {
                channel: "EMAIL",
                status: "FAILED",
                error: error.message,
                rawResponse: null,
            };
        }
    }
}

export const emailAdapter = new NovaEmailAdapter();

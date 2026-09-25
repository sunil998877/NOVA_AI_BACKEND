
import nodemailer from "nodemailer";
import { env } from "../config/env.js";

const transporterCache = new Map();

export function getSmtpTransporter(portOverride) {
    const port = portOverride || env.smtp.port || 587;
    if (transporterCache.has(port)) return transporterCache.get(port);

    const transporter = nodemailer.createTransport({
        host: env.smtp.host,
        port,
        secure: port === 465,
        auth: {
            user: env.smtp.user,
            pass: env.smtp.pass,
        },
        tls: {
            rejectUnauthorized: false,
        },

        connectionTimeout: 12_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,

        pool: true,
        maxConnections: 5,
        maxMessages: 100,
    });

    transporterCache.set(port, transporter);
    return transporter;
}

export async function sendViaSMTP({ to, subject, html, text, from, replyTo, headers }) {
    const plainText = text || (html ? html.replace(/<[^>]+>/g, "") : "");
    const primaryPort = env.smtp.port || 587;
    const fallbackPort = primaryPort === 465 ? 587 : 465;

    const smtpFrom = env.smtp.from ||
        (env.smtp.user ? `"${env.novaSenderName || "NOVA AI"}" <${env.smtp.user}>` : from);

    const effectiveReplyTo = replyTo || (from && from !== smtpFrom ? from : undefined);

    const mailOptions = {
        from: smtpFrom,
        to,
        subject,
        html,
        text: plainText,
        replyTo: effectiveReplyTo || undefined,
        headers: headers || undefined,
    };

    try {
        const transporter = getSmtpTransporter(primaryPort);
        const info = await transporter.sendMail(mailOptions);
        return { messageId: info.messageId, deliveryMethod: "smtp" };
    } catch (err) {
        console.warn(`[SMTP] Primary port ${primaryPort} failed:`, err.message);
    }

    try {
        const fallbackTransporter = getSmtpTransporter(fallbackPort);
        const info = await fallbackTransporter.sendMail(mailOptions);
        console.log(`[SMTP] Fallback port ${fallbackPort} succeeded for ${to}`);
        return { messageId: info.messageId, deliveryMethod: "smtp_ssl" };
    } catch (err) {
        throw new Error(`SMTP delivery failed on both ports (${primaryPort} & ${fallbackPort}): ${err.message}`);
    }
}

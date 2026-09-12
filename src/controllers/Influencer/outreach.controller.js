import nodemailer from "nodemailer";
import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { Influencer } from "../../models/influencer.model.js";
import { Collaboration } from "../../models/collaboration.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { env } from "../../config/env.js";
import { fetchWithTimeout } from "../../utils/fetch.js";
import { signCampaignSendToken } from "../../utils/campaign-send-token.js";
import { getPublicApiUrl } from "../../utils/urlHelper.js";
import { sendMail } from "../../utils/mailer.js";

async function sendViaSmtp({ to, subject, html, text, from, replyTo }) {
    const port = env.smtp?.port || 587;
    const transporter = nodemailer.createTransport({
        host: env.smtp?.host,
        port,
        secure: port === 465,
        auth: {
            user: env.smtp?.user,
            pass: env.smtp?.pass,
        },
        tls: {
            rejectUnauthorized: false,
        },
        connectionTimeout: 12000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
    });
    return await transporter.sendMail({
        from: from || env.smtp?.from || `"${env.novaSenderName}" <${env.smtp?.user}>`,
        to,
        subject,
        html,
        text,
        replyTo: replyTo || undefined,
    });
}

async function callN8nWebhook(payload) {
    const webhookUrl = env.n8nWebhookUrl;
    if (!webhookUrl) return null;

    const method = String(env.n8nWebhookMethod || "POST").toUpperCase();
    const headers = {
        "User-Agent": "NovaAI-Backend/1.0",
    };

    if (env.n8nUser && env.n8nPassword) {
        headers.Authorization = `Basic ${Buffer.from(`${env.n8nUser}:${env.n8nPassword}`).toString("base64")}`;
    }

    if (method !== "GET") {
        headers["Content-Type"] = "application/json";

        if (webhookUrl.includes("/webhook/")) {
            const testUrl = webhookUrl.replace("/webhook/", "/webhook-test/");
            fetchWithTimeout(testUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(payload),
            }, 2000)
                .then((r) => {
                    if (r.ok) console.log("[n8n] Test webhook canvas triggered (POST):", r.status);
                })
                .catch(() => { });
        }

        const res = await fetchWithTimeout(webhookUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
        });
        console.log("[n8n] POST response:", res.status);
        return res;
    }

    const firstRecipient = (payload.recipients && payload.recipients[0]) || {};
    const effectiveSenderName = payload.senderName || env.novaSenderName;
    const effectiveSenderEmail = payload.senderEmail || env.novaSenderEmail;
    const query = new URLSearchParams({
        campaignId: String(payload.campaignId),
        action: payload.action || "start_campaign",
        timestamp: payload.timestamp || new Date().toISOString(),
        totalRecipients: String(payload.totalRecipients ?? 0),
        senderEmail: effectiveSenderEmail,
        senderName: effectiveSenderName,
        from: payload.from || `"${effectiveSenderName}" <${effectiveSenderEmail}>`,
    });
    if (payload.subject) query.set("subject", payload.subject);
    if (payload.body) query.set("body", payload.body);
    if (payload.html) query.set("html", payload.html);
    if (payload.accessToken) query.set("accessToken", payload.accessToken);
    if (payload.apiBaseUrl) query.set("apiBaseUrl", payload.apiBaseUrl);

    if (firstRecipient.email || firstRecipient.recipientEmail) {
        const toEmail = firstRecipient.email || firstRecipient.recipientEmail;
        const toName = firstRecipient.recipientName || firstRecipient.full_name || "";
        query.set("to", toEmail);
        query.set("email", toEmail);
        query.set("recipientEmail", toEmail);
        if (toName) query.set("recipientName", toName);
    }

    if (payload.recipients) {
        const compact = payload.recipients.map((r) => ({
            id: r.id,
            email: r.email || r.recipientEmail,
            recipientEmail: r.recipientEmail || r.email,
            full_name: r.full_name || r.recipientName || "",
            recipientName: r.recipientName || r.full_name || "",
        }));
        query.set("recipients", JSON.stringify(compact));
    }

    const fullUrl = `${webhookUrl}?${query}`;
    console.log("[n8n] GET →", webhookUrl, "| campaignId:", payload.campaignId, "| recipients:", payload.totalRecipients);

    if (webhookUrl.includes("/webhook/")) {
        const testUrl = webhookUrl.replace("/webhook/", "/webhook-test/");
        fetchWithTimeout(`${testUrl}?${query}`, { method: "GET", headers }, 2000)
            .then((r) => {
                if (r.ok) console.log("[n8n] Test webhook canvas triggered (GET):", r.status);
            })
            .catch(() => { });
    }

    const res = await fetchWithTimeout(fullUrl, {
        method: "GET",
        headers,
    });
    console.log("[n8n] GET response:", res.status);
    return res;
}

export const sendInfluencerOutreach = asyncHandler(async (req, res) => {
    const {
        influencerId,
        name,
        influencerName,
        username,
        influencerUsername,
        platform = "youtube",
        profileImage,
        profileUrl,
        email,
        subject,
        message,
    } = req.body;

    if (!email || !String(email).trim()) {
        return res.status(400).json({ error: "Recipient email is required" });
    }

    if (!subject || !String(subject).trim()) {
        return res.status(400).json({ error: "Subject is required" });
    }

    if (!message || !String(message).trim()) {
        return res.status(400).json({ error: "Message body is required" });
    }

    const recipientEmail = String(email).trim();
    const cleanSubject = String(subject).trim();
    const cleanMessage = String(message).trim();
    const creatorName = String(name || influencerName || "Creator").trim();
    const creatorUsername = username || influencerUsername || null;

    const senderEmail = (
        req.body?.senderEmail ||
        req.user?.email ||
        env.novaSenderEmail ||
        "nova@evokeaisolutions.com"
    ).trim();

    const senderName = (
        req.body?.senderName ||
        req.user?.fullName ||
        env.novaSenderName ||
        "NOVA AI"
    ).trim();

    const fromAddress = `"${senderName}" <${senderEmail}>`;

    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #222; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background-color: #ffffff; padding: 24px; border: 1px solid #e1e4e8; border-radius: 8px;">
    <div style="white-space: pre-wrap; font-size: 15px;">${cleanMessage.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
    <hr style="border: 0; border-top: 1px solid #eee; margin: 24px 0 12px 0;" />
    <p style="font-size: 12px; color: #888; margin: 0;">Sent via ${senderName}</p>
  </div>
</body>
</html>`;

    let resolvedInfluencerId = influencerId;
    if (resolvedInfluencerId) {
        try {
            await Influencer.updateStatus(resolvedInfluencerId, req.user.id, {
                status: "contacted",
                lastContact: new Date(),
                email: recipientEmail,
            });
        } catch (_) {}
    } else if (creatorName) {
        try {
            const upserted = await Influencer.upsertAndSave(req.user.id, {
                name: creatorName,
                username: creatorUsername,
                platform,
                profileImage,
                profileUrl,
                email: recipientEmail,
                status: "contacted",
                lastContact: new Date(),
            });
            if (upserted?.id) {
                resolvedInfluencerId = upserted.id;
            }
        } catch (_) {}
    }

    let createdCamp = null;
    let createdMail = null;
    try {
        createdCamp = await Campaign.create({
            title: `Outreach to ${creatorName}`,
            sender_name: senderName,
            sender_email: senderEmail,
            subject: cleanSubject,
            body: cleanMessage,
            status: "processing",
            camp_status: "Processing",
            user_id: req.user.id,
        });

        if (createdCamp?.id) {
            createdMail = await Mail.create({
                campaign_id: createdCamp.id,
                email: recipientEmail,
                full_name: creatorName,
                status: 0,
                delivery_status: "pending",
            });
        }
    } catch (_) {}

    const campaignId = createdCamp?.id || resolvedInfluencerId || Date.now();
    let accessToken = "";
    try {
        accessToken = signCampaignSendToken({
            campaignId,
            userId: req.user.id,
        });
    } catch (_) {}

    let apiBaseUrl = "";
    try {
        apiBaseUrl = await getPublicApiUrl(req);
    } catch (_) {}

    const recipient = {
        id: createdMail?.id || resolvedInfluencerId || 1,
        email: recipientEmail,
        recipientEmail,
        full_name: creatorName,
        recipientName: creatorName,
        campaign_id: campaignId,
        subject: cleanSubject,
        body: cleanMessage,
        html: htmlBody,
        senderEmail,
        senderName,
        from: fromAddress,
    };

    const payload = {
        campaignId,
        senderEmail,
        senderName,
        from: fromAddress,
        fromEmail: senderEmail,
        subject: cleanSubject,
        body: cleanMessage,
        html: htmlBody,
        action: "start_campaign",
        totalRecipients: 1,
        timestamp: new Date().toISOString(),
        accessToken,
        apiBaseUrl,
        recipients: [recipient],
        data: [recipient],
    };

    let deliveryMethod = "n8n";
    let n8nSuccess = false;
    let n8nError = null;

    if (env.n8nWebhookUrl) {
        try {
            const n8nRes = await callN8nWebhook(payload);
            n8nSuccess = Boolean(n8nRes && n8nRes.ok);
            if (!n8nSuccess && n8nRes) {
                n8nError = `n8n responded with status ${n8nRes.status}`;
            }
        } catch (err) {
            console.error("[sendInfluencerOutreach] n8n webhook error:", err.message);
            n8nError = err.message;
        }
    } else {
        n8nError = "N8N_WEBHOOK_URL is not configured in backend environment";
    }

    if (!n8nSuccess) {
        try {
            const smtpRes = await sendMail({
                to: recipientEmail,
                subject: cleanSubject,
                html: htmlBody,
                text: cleanMessage,
                from: fromAddress,
                replyTo: req.user?.email || undefined,
            });
            deliveryMethod = smtpRes?.deliveryMethod || "smtp";
        } catch (smtpErr) {
            return res.status(502).json({
                error: "Failed to dispatch outreach email via n8n and SMTP",
                details: n8nError || smtpErr.message,
            });
        }
    }

    if (createdCamp?.id) {
        try {
            await Campaign.updateById(createdCamp.id, {
                status: "sent",
                camp_status: "Sent",
                sent_count: 1,
            });
            if (createdMail?.id) {
                await Mail.updateById(createdMail.id, {
                    status: 1,
                    delivery_status: "sent",
                    sent_at: new Date(),
                });
            }
        } catch (_) {}
    }

    const collaboration = await Collaboration.create({
        userId: req.user.id,
        influencerId: resolvedInfluencerId || null,
        influencerName: creatorName,
        influencerUsername: creatorUsername,
        platform,
        profileImage,
        profileUrl,
        recipientEmail,
        subject: cleanSubject,
        message: cleanMessage,
        status: "sent",
        deliveryMethod,
    });

    return res.status(200).json({
        success: true,
        message: deliveryMethod === "n8n" ? "Outreach email sent successfully via n8n" : "Outreach email sent successfully via SMTP",
        deliveryMethod,
        collaboration,
    });
});

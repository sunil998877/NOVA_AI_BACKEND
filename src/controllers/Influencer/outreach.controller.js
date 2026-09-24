import crypto from "crypto";
import nodemailer from "nodemailer";
import { Campaign } from "../../models/campaign.model.js";
import { Mail } from "../../models/mail.model.js";
import { Influencer } from "../../models/influencer.model.js";
import { Collaboration } from "../../models/collaboration.model.js";
import { CollaborationMessage } from "../../models/collaboration-message.model.js";
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
    let cleanSubject = String(subject).trim();
    if (/^(?:(?:following\s*up|re|fwd):\s*){2,}/i.test(cleanSubject)) {
        const rootSubject = cleanSubject.replace(/^(?:(?:following\s*up|re|fwd):\s*)+/gi, "").trim();
        cleanSubject = `Following up: ${rootSubject}`;
    }
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

    const accessToken = crypto.randomBytes(20).toString("hex");
    let rawWhatsapp = req.body?.whatsappNumber ? String(req.body.whatsappNumber).trim() : null;
    if (!rawWhatsapp && req.user?.id) {
        try {
            if (influencerId) {
                const prevCollab = await Collaboration.findLatestByInfluencerAndUser(influencerId, req.user.id);
                if (prevCollab?.whatsapp_number) {
                    rawWhatsapp = prevCollab.whatsapp_number;
                }
            }
            if (!rawWhatsapp) {
                const rows = await Collaboration.listByUser(req.user.id, { limit: 10 });
                const found = rows.find((r) => r.whatsapp_number && r.whatsapp_number.trim());
                if (found?.whatsapp_number) {
                    rawWhatsapp = found.whatsapp_number;
                }
            }
        } catch (_) { }
    }
    const cleanWhatsapp = rawWhatsapp ? rawWhatsapp.replace(/[^\d+]/g, "") : null;

    const candidateOrigins = [
        req.body?.portalBaseUrl,
        req.body?.clientUrl,
        req.body?.frontendUrl,
        req.headers["x-frontend-url"],
        req.headers.origin,
        req.headers.referer ? (() => {
            try { return new URL(req.headers.referer).origin; } catch (_) { return ""; }
        })() : "",
        process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "",
        process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
        process.env.FRONTEND_URL,
        env.frontendUrl,
        env.clientUrl,
        ...(Array.isArray(env.allowedOrigins) ? env.allowedOrigins : []),
    ].filter(Boolean).map((u) => String(u).trim().replace(/\/+$/, ""));

    const liveVercelOrigin = candidateOrigins.find((u) => u.includes("vercel.app"));
    const liveCustomOrigin = candidateOrigins.find((u) => u.startsWith("https://") && !u.includes("localhost") && !u.includes("127.0.0.1") && !u.includes("ngrok") && !u.includes("onrender.com"));

    let clientBaseUrl = liveVercelOrigin || liveCustomOrigin;
    if (!clientBaseUrl) {
        clientBaseUrl = candidateOrigins.find((u) => !u.includes("localhost") && !u.includes("127.0.0.1")) || candidateOrigins[0] || "http://localhost:5173";
    }
    const portalUrl = `${clientBaseUrl.replace(/\/+$/, "")}/collab/${accessToken}`;

    let waUrl = portalUrl;
    if (cleanWhatsapp) {
        const waNumberOnly = cleanWhatsapp.replace(/^\+/, "");
        const waText = encodeURIComponent(
            `Hi! I received your collaboration invite from ${senderName} regarding my channel ${creatorUsername || creatorName}. Let's discuss details!`
        );
        waUrl = `https://wa.me/${waNumberOnly}?text=${waText}`;
    } else {
        const waText = encodeURIComponent(
            `Hi! I received your collaboration invite from ${senderName} regarding my channel ${creatorUsername || creatorName}. Let's discuss details!`
        );
        waUrl = `https://wa.me/?text=${waText}`;
    }

    const whatsappButtonHtml = `
      <a href="${waUrl}" target="_blank" style="display: inline-block; background: #25D366; color: #ffffff; text-decoration: none; padding: 11px 20px; border-radius: 8px; font-weight: bold; font-size: 13px; margin-top: 6px; margin-right: 8px; box-shadow: 0 2px 5px rgba(37, 211, 102, 0.25);">
        💬 Chat on WhatsApp
      </a>
    `;

    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1e293b; max-width: 620px; margin: 0 auto; padding: 24px 16px; background-color: #f8fafc;">
  <div style="background-color: #ffffff; padding: 32px; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.03);">
    <!-- Header Badge & Subject -->
    <div style="margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #f1f5f9;">
      <span style="display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #0d9488; background: #ccfbf1; padding: 4px 10px; border-radius: 9999px;">
        Partnership Opportunity
      </span>
      <h2 style="margin: 12px 0 4px 0; font-size: 19px; color: #0f172a; font-weight: 700;">
        ${cleanSubject}
      </h2>
    </div>

    <!-- Message Content -->
    <div style="white-space: pre-wrap; font-size: 15px; color: #334155; line-height: 1.65; margin-bottom: 28px;">${cleanMessage.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>

    <!-- Interactive Call to Action Banner -->
    <div style="background: linear-gradient(135deg, #f0fdfa 0%, #f8fafc 100%); border: 1px solid #99f6e4; border-radius: 10px; padding: 20px; margin: 28px 0; text-align: left;">
      <h3 style="margin: 0 0 6px 0; font-size: 15px; font-weight: 700; color: #0f766e;">
        🤝 Ready to discuss deliverables or rates?
      </h3>
      <p style="margin: 0 0 14px 0; font-size: 13px; color: #475569;">
        Connect directly with our partnerships lead. No account or password needed:
      </p>
      <div>
        <a href="${portalUrl}" target="_blank" style="display: inline-block; background: #0d9488; color: #ffffff; text-decoration: none; padding: 11px 20px; border-radius: 8px; font-weight: bold; font-size: 13px; margin-top: 6px; margin-right: 8px; box-shadow: 0 2px 6px rgba(13, 148, 136, 0.3);">
          🤝 Open Collaboration Portal
        </a>
        ${whatsappButtonHtml}
      </div>
    </div>

    <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0 16px 0;" />
    <div style="font-size: 12px; color: #94a3b8;">
      <span>Sent via ${senderName}</span>
      <span style="float: right;"><a href="${portalUrl}" style="color: #0d9488; text-decoration: none;">Collaboration Portal</a></span>
    </div>
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
        } catch (_) { }
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
        } catch (_) { }
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
                user_id: req.user.id,
                email: recipientEmail,
                full_name: creatorName,
                status: 0,
                delivery_status: "pending",
            });
        }
    } catch (_) { }

    const campaignId = createdCamp?.id || resolvedInfluencerId || Date.now();
    let campaignSendToken = "";
    try {
        campaignSendToken = signCampaignSendToken({
            campaignId,
            userId: req.user.id,
        });
    } catch (_) { }

    let apiBaseUrl = "";
    try {
        apiBaseUrl = await getPublicApiUrl(req);
    } catch (_) { }

    let finalHtml = htmlBody;
    if (
        apiBaseUrl &&
        createdMail?.id &&
        createdCamp?.id &&
        /^https:\/\//i.test(apiBaseUrl) &&
        !/localhost|127\.0\.0\.1/i.test(apiBaseUrl)
    ) {
        const pixel = `<img src="${apiBaseUrl.replace(/\/$/, "")}/api/tracking/open/${createdCamp.id}/${createdMail.id}?t=${Date.now()}" width="1" height="1" alt="" border="0" style="width:1px;height:1px;border:0;outline:none;text-decoration:none;display:block;" />`;
        finalHtml = /<\/body>/i.test(htmlBody)
            ? htmlBody.replace(/<\/body>/i, `${pixel}</body>`)
            : `${htmlBody}${pixel}`;
    }

    const recipient = {
        id: createdMail?.id || resolvedInfluencerId || 1,
        email: recipientEmail,
        recipientEmail,
        full_name: creatorName,
        recipientName: creatorName,
        campaign_id: campaignId,
        subject: cleanSubject,
        body: cleanMessage,
        html: finalHtml,
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
        html: finalHtml,
        action: "start_campaign",
        totalRecipients: 1,
        timestamp: new Date().toISOString(),
        accessToken: campaignSendToken,
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
                html: finalHtml,
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
                total_recipients: 1,
            });
            if (createdMail?.id) {
                await Mail.updateById(createdMail.id, {
                    status: 1,
                    delivery_status: "sent",
                    sent_at: new Date(),
                });
            }
        } catch (_) { }
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
        accessToken,
        whatsappNumber: cleanWhatsapp,
    });

    if (collaboration?.id) {
        try {
            await CollaborationMessage.create({
                collaborationId: collaboration.id,
                senderType: "marketer",
                senderName: senderName || "NOVA AI",
                content: cleanMessage,
            });
        } catch (msgErr) {
            console.warn("Could not seed initial collaboration message:", msgErr.message);
        }
    }

    return res.status(200).json({
        success: true,
        message: deliveryMethod === "n8n" ? "Outreach email sent successfully via n8n" : "Outreach email sent successfully via SMTP",
        deliveryMethod,
        collaboration,
        portalUrl,
        accessToken,
    });
});

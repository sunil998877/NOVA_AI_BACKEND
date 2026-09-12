import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { fetchWithTimeout } from "./fetch.js";

function getTransporter(portOverride) {
  const port = portOverride || env.smtp.port;
  return nodemailer.createTransport({
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
    connectionTimeout: 12000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

async function sendViaN8nWebhook({ to, subject, html, text, from }) {
  const webhookUrl = env.n8nWebhookUrl;
  if (!webhookUrl) return null;

  const senderName = env.novaSenderName || "NOVA AI";
  const senderEmail = env.smtp.user || env.novaSenderEmail || "nova@evokeaisolutions.com";
  const effectiveFrom = from || `"${senderName}" <${senderEmail}>`;

  const payload = {
    action: "start_campaign",
    to,
    email: to,
    recipientEmail: to,
    recipientName: "",
    subject,
    body: text || (html ? html.replace(/<[^>]+>/g, "") : ""),
    html,
    from: effectiveFrom,
    senderEmail,
    senderName,
    timestamp: new Date().toISOString(),
    totalRecipients: 1,
    recipients: [
      {
        id: 1,
        email: to,
        recipientEmail: to,
        full_name: "",
        recipientName: "",
      }
    ],
  };

  const method = String(env.n8nWebhookMethod || "POST").toUpperCase();
  const headers = {
    "User-Agent": "NovaAI-Mailer/1.0",
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
      }, 2000).catch(() => { });
    }

    const res = await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, 15000);

    if (!res.ok) {
      throw new Error(`n8n webhook responded with status ${res.status}`);
    }

    return { messageId: `n8n-${Date.now()}`, deliveryMethod: "n8n_webhook" };
  }

  const query = new URLSearchParams({
    campaignId: String(Date.now()),
    action: "start_campaign",
    timestamp: payload.timestamp,
    totalRecipients: "1",
    senderEmail,
    senderName,
    from: effectiveFrom,
    to,
    email: to,
    recipientEmail: to,
    subject: subject || "",
    body: payload.body || "",
    html: html || "",
    recipients: JSON.stringify(payload.recipients),
  });

  const fullUrl = `${webhookUrl}?${query}`;

  if (webhookUrl.includes("/webhook/")) {
    const testUrl = webhookUrl.replace("/webhook/", "/webhook-test/");
    fetchWithTimeout(`${testUrl}?${query}`, { method: "GET", headers }, 2000).catch(() => { });
  }

  const res = await fetchWithTimeout(fullUrl, {
    method: "GET",
    headers,
  }, 15000);

  if (!res.ok) {
    throw new Error(`n8n webhook responded with status ${res.status}`);
  }

  return { messageId: `n8n-${Date.now()}`, deliveryMethod: "n8n_webhook" };
}


export async function sendMail({ to, subject, html, text, from, replyTo, headers }) {
  const senderName = env.novaSenderName || "NOVA AI";
  const senderEmail = env.smtp.user || env.novaSenderEmail || "nova@evokeaisolutions.com";
  const effectiveFrom = from || env.smtp.from || `"${senderName}" <${senderEmail}>`;

  let primaryErr = null;
  try {
    const transporter = getTransporter(env.smtp.port || 587);
    const info = await transporter.sendMail({
      from: effectiveFrom,
      to,
      subject,
      html,
      text: text || (html ? html.replace(/<[^>]+>/g, "") : ""),
      replyTo: replyTo || undefined,
      headers: headers || undefined,
    });
    return { ...info, deliveryMethod: "smtp" };
  } catch (err) {
    primaryErr = err;
    console.warn("Primary SMTP failed, trying port 465 SSL:", err.message);
  }

  try {
    const fallbackPort = env.smtp.port === 465 ? 587 : 465;
    const fallbackTransporter = getTransporter(fallbackPort);
    const info = await fallbackTransporter.sendMail({
      from: effectiveFrom,
      to,
      subject,
      html,
      text: text || (html ? html.replace(/<[^>]+>/g, "") : ""),
      replyTo: replyTo || undefined,
      headers: headers || undefined,
    });
    return { ...info, deliveryMethod: "smtp_ssl" };
  } catch (fallbackErr) {
    console.warn("Fallback SMTP failed, trying n8n webhook:", fallbackErr.message);
  }

  if (env.n8nWebhookUrl) {
    try {
      const n8nResult = await sendViaN8nWebhook({ to, subject, html, text, from: effectiveFrom });
      if (n8nResult) {
        return n8nResult;
      }
    } catch (n8nErr) {
      console.error("n8n delivery failed:", n8nErr.message);
    }
  }

  throw primaryErr || new Error("Failed to send email through all available mail channels");
}

export async function sendPasswordResetEmail({ to, resetUrl }) {
  const subject = "Reset your NOVA password";
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your NOVA password</title>
</head>
<body style="margin:0;padding:0;background:#0d1117;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#161b22;border-radius:12px;overflow:hidden;border:1px solid #30363d;">
          <tr>
            <td style="background:linear-gradient(135deg,#00c9a7 0%,#0a6eff 100%);padding:32px 40px;text-align:center;">
              <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">NOVA</h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:13px;">AI Email Marketer</p>
            </td>
          </tr>
          <tr>
            <td style="padding:40px 40px 32px;">
              <h2 style="margin:0 0 12px;color:#f0f6fc;font-size:20px;font-weight:600;">Reset your password</h2>
              <p style="margin:0 0 24px;color:#8b949e;font-size:14px;line-height:1.6;">
                We received a request to reset the password for your NOVA account. Click the button below to choose a new password. The link expires in <strong style="color:#f0f6fc;">1 hour</strong>.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                <tr>
                  <td style="border-radius:8px;background:linear-gradient(135deg,#00c9a7 0%,#0a6eff 100%);">
                    <a href="${resetUrl}" target="_blank"
                       style="display:inline-block;padding:14px 36px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:0.2px;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;color:#8b949e;font-size:12px;line-height:1.5;">
                Button not working? Copy and paste this URL into your browser:
              </p>
              <p style="margin:0 0 24px;word-break:break-all;font-size:12px;">
                <a href="${resetUrl}" style="color:#58a6ff;text-decoration:none;">${resetUrl}</a>
              </p>
              <hr style="border:none;border-top:1px solid #30363d;margin:24px 0;" />
              <p style="margin:0;color:#6e7681;font-size:11px;line-height:1.5;">
                If you didn't request a password reset, you can safely ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return sendMail({ to, subject, html });
}

import nodemailer from "nodemailer";
import { env } from "../config/env.js";

function getTransporter() {
    return nodemailer.createTransport({
        host: env.smtp.host,
        port: env.smtp.port,
        secure: env.smtp.port === 465,
        auth: {
            user: env.smtp.user,
            pass: env.smtp.pass,
        },
        tls: {
            rejectUnauthorized: false,
        },
    });
}

export async function sendMail({ to, subject, html, text }) {
    const transporter = getTransporter();
    return transporter.sendMail({
        from: env.smtp.from,
        to,
        subject,
        html,
        text: text || html.replace(/<[^>]+>/g, ""),
    });
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
              <p style="margin:0 0 8px;color:#8b949e;font-size:13px;line-height:1.6;">
                Or copy and paste this URL into your browser:
              </p>
              <p style="margin:0;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px 14px;word-break:break-all;font-size:12px;">
                <a href="${resetUrl}" style="color:#58a6ff;text-decoration:none;">${resetUrl}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="border-top:1px solid #21262d;padding:24px 40px;text-align:center;">
              <p style="margin:0 0 6px;color:#6e7681;font-size:12px;">
                If you didn't request a password reset, you can safely ignore this email.
              </p>
              <p style="margin:0;color:#6e7681;font-size:12px;">&copy; ${new Date().getFullYear()} NOVA AI. All rights reserved.</p>
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

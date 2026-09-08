import { marked } from "marked";

/**
 * Configure marked for email generation
 */
marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Sanitizes HTML to prevent XSS in email clients
 */
export function sanitizeHtml(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "")
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, "")
    .replace(/on\w+="[^"]*"/gi, "")
    .replace(/on\w+='[^']*'/gi, "")
    .replace(/javascript:[^"']*/gi, "#");
}

/**
 * Resolves template placeholders such as {{recipient_name}}, [Recipient's Name], etc.
 */
export function resolvePlaceholders(text, recipient = {}, campaign = {}) {
  if (!text || typeof text !== "string") return "";

  const fullName = (recipient.full_name || recipient.fullName || recipient.name || "").trim();
  const firstName = fullName ? fullName.split(/\s+/)[0] : "";
  const email = (recipient.email || "").trim();
  const organization = (recipient.organization || campaign.organization || "NOVA").trim();
  const campaignTitle = (campaign.title || campaign.campaign_name || "Campaign").trim();
  const senderName = (campaign.sender_name || campaign.workMail || "Sunil Kumar").trim();

  let resolved = text;

  // 1. Specific recipient name placeholders
  const namePatterns = [
    /\{\{\s*(?:recipient_name|recipientName|full_name|fullName|name)\s*\}\}/gi,
    /\[\s*Recipient(?:'s)?\s*Name\s*\]/gi,
    /\[\s*Recipient\s*\]/gi,
    /\[\s*Customer\s*Name\s*\]/gi,
    /\[\s*Client\s*Name\s*\]/gi,
  ];

  const greetingFallback = fullName || firstName || "there";
  for (const pattern of namePatterns) {
    resolved = resolved.replace(pattern, greetingFallback);
  }

  // 2. First name placeholders
  resolved = resolved.replace(/\{\{\s*(?:first_name|firstName)\s*\}\}/gi, firstName || "there");

  // 3. Email placeholders
  resolved = resolved.replace(/\{\{\s*email\s*\}\}/gi, email);

  // 4. Company / Organization placeholders
  const companyPatterns = [
    /\{\{\s*(?:company|organization|org)\s*\}\}/gi,
    /\[\s*(?:Company|Organization)\s*Name\s*\]/gi,
  ];
  for (const pattern of companyPatterns) {
    resolved = resolved.replace(pattern, organization || "your company");
  }

  // 5. Campaign Title placeholders
  resolved = resolved.replace(/\{\{\s*campaign_title\s*\}\}/gi, campaignTitle);

  // 6. Sender name placeholders
  const senderPatterns = [
    /\{\{\s*(?:sender_name|senderName)\s*\}\}/gi,
    /\[\s*Your\s*Name\s*\]/gi,
    /\[\s*Sender\s*Name\s*\]/gi,
  ];
  for (const pattern of senderPatterns) {
    resolved = resolved.replace(pattern, senderName);
  }

  // 7. Clean up any lingering square-bracketed prompt artifacts like [Insert Link], [Your Title], etc.
  resolved = resolved.replace(/\[\s*Insert\s*Link\s*\]/gi, "Click here");
  resolved = resolved.replace(/\[\s*(?:Your\s*Title|Title)\s*\]/gi, "Team");
  resolved = resolved.replace(/\[\s*(?:Product|Service)\s*Name\s*\]/gi, campaignTitle || "our services");

  return resolved;
}

/**
 * Enhances standard markdown HTML output with email-safe inline styles and button CTAs
 */
function applyEmailInlineStyles(html) {
  let styled = html;

  // Headings
  styled = styled.replace(
    /<h1>/gi,
    '<h1 style="margin: 0 0 16px 0; color: #111827; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; font-weight: 700; line-height: 1.3; letter-spacing: -0.3px;">'
  );
  styled = styled.replace(
    /<h2>/gi,
    '<h2 style="margin: 20px 0 12px 0; color: #1f2937; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; font-size: 20px; font-weight: 600; line-height: 1.35;">'
  );
  styled = styled.replace(
    /<h3>/gi,
    '<h3 style="margin: 16px 0 10px 0; color: #374151; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; font-size: 17px; font-weight: 600; line-height: 1.4;">'
  );

  // Paragraphs
  styled = styled.replace(
    /<p>/gi,
    '<p style="margin: 0 0 16px 0; color: #374151; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.65; word-break: break-word;">'
  );

  // Bullet Lists (clean email-safe indentation and bullets)
  styled = styled.replace(
    /<ul>/gi,
    '<ul style="margin: 0 0 20px 0; padding-left: 20px; color: #374151; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6;">'
  );
  styled = styled.replace(
    /<ol>/gi,
    '<ol style="margin: 0 0 20px 0; padding-left: 24px; color: #374151; font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6;">'
  );
  styled = styled.replace(
    /<li>/gi,
    '<li style="margin-bottom: 8px; padding-left: 4px;">'
  );

  // Strong & Emphasis
  styled = styled.replace(
    /<strong>/gi,
    '<strong style="color: #111827; font-weight: 600;">'
  );
  styled = styled.replace(
    /<em>/gi,
    '<em style="color: #4b5563;">'
  );

  // Blockquotes
  styled = styled.replace(
    /<blockquote>/gi,
    '<blockquote style="margin: 0 0 20px 0; padding: 12px 18px; border-left: 4px solid #ef5a2e; background-color: #fef7f5; color: #4b5563; font-style: italic; border-radius: 0 8px 8px 0;">'
  );

  // Horizontal rules
  styled = styled.replace(
    /<hr\s*\/?>/gi,
    '<hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />'
  );

  // Convert CTA links (e.g. [CTA: Button](url) or prominent standalone links) into email-safe buttons
  styled = styled.replace(
    /<p>\s*<a\s+href="([^"]+)"(?:\s+[^>]*)?>\s*(?:CTA:\s*)?([^<]+?)\s*<\/a>\s*<\/p>/gi,
    (match, url, label) => {
      // If label looks like action button text (or <= 40 chars)
      if (label.length <= 50 && !/^https?:\/\//i.test(label)) {
        return `
        <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin: 22px 0;">
          <tr>
            <td align="center" style="border-radius: 8px; background-color: #ef5a2e;">
              <a href="${url}" target="_blank" style="display: inline-block; padding: 13px 28px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 8px; letter-spacing: 0.2px;">
                ${label} &rarr;
              </a>
            </td>
          </tr>
        </table>`;
      }
      return match;
    }
  );

  // Standard inline links
  styled = styled.replace(
    /<a\s+(?!style=)(href="[^"]+")/gi,
    '<a $1 style="color: #ef5a2e; font-weight: 500; text-decoration: underline;" target="_blank"'
  );

  return styled;
}

/**
 * Rewrites <a href="..."> links for click tracking
 */
export function wrapClickTracking(html, mailId, apiBaseUrl) {
  if (!html || !mailId || !apiBaseUrl) return html;
  const trackingEndpoint = `${apiBaseUrl.replace(/\/$/, "")}/api/track/click/${mailId}`;

  return html.replace(/<a\s+([^>]*?)href="([^"]+)"([^>]*?)>/gi, (match, prefix, href, suffix) => {
    // Do not track mailto, tel, anchors or tracking links
    if (/^(mailto:|tel:|#|\/api\/track)/i.test(href)) {
      return match;
    }
    const trackedHref = `${trackingEndpoint}?url=${encodeURIComponent(href)}`;
    return `<a ${prefix}href="${trackedHref}"${suffix}>`;
  });
}

/**
 * Generates email-safe plain text fallback from markdown
 */
export function generatePlainText(text, recipient = {}, campaign = {}) {
  const resolved = resolvePlaceholders(text, recipient, campaign);
  return resolved
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Renders the full responsive HTML email template
 */
export function renderCampaignEmail({
  subject = "",
  body = "",
  recipient = {},
  campaign = {},
  mailId = null,
  apiBaseUrl = "",
  enableTracking = true,
}) {
  // 1. Resolve variables in subject and body
  const resolvedSubject = resolvePlaceholders(subject, recipient, campaign);
  const resolvedBodyMarkdown = resolvePlaceholders(body, recipient, campaign);

  // 2. Convert markdown to HTML
  const rawHtml = marked.parse(resolvedBodyMarkdown);
  const sanitizedHtml = sanitizeHtml(rawHtml);
  let styledBody = applyEmailInlineStyles(sanitizedHtml);

  // 3. Apply click tracking if mailId and apiBaseUrl are provided
  if (enableTracking && mailId && apiBaseUrl) {
    styledBody = wrapClickTracking(styledBody, mailId, apiBaseUrl);
  }

  // 4. Build open tracking pixel
  let trackingPixel = "";
  if (enableTracking && mailId && apiBaseUrl) {
    const trackingUrl = `${apiBaseUrl.replace(/\/$/, "")}/api/track/open/${mailId}`;
    trackingPixel = `<img src="${trackingUrl}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:none;outline:none;max-height:0;max-width:0;opacity:0;" />`;
  }

  const recipientEmail = recipient.email || "recipient";
  const campaignName = campaign.title || campaign.campaign_name || "NOVA Campaign";
  const organization = campaign.organization || "NOVA AI";
  const currentYear = new Date().getFullYear();

  // 5. Full responsive HTML template
  const fullHtml = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="x-apple-disable-message-reformatting">
  <title>${resolvedSubject}</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style type="text/css">
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    table { border-collapse: collapse !important; }
    body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #f7f5f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    @media screen and (max-width: 600px) {
      .email-container { width: 100% !important; padding: 12px !important; }
      .content-cell { padding: 24px 20px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f5f0; -webkit-font-smoothing: antialiased;">
  <div style="display: none; font-size: 1px; color: #f7f5f0; line-height: 1px; max-height: 0px; max-width: 0px; opacity: 0; overflow: hidden;">
    ${resolvedSubject}
  </div>
  <table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="background-color: #f7f5f0; min-height: 100%;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table border="0" cellpadding="0" cellspacing="0" width="600" class="email-container" role="presentation" style="max-width: 600px; width: 100%;">
          
          <!-- BRAND / TOP ACCENT -->
          <tr>
            <td align="center" style="padding-bottom: 20px;">
              <table border="0" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center" style="vertical-align: middle;">
                    <div style="width: 28px; height: 28px; border-radius: 8px; background-color: #ef5a2e; display: inline-block; vertical-align: middle; text-align: center; line-height: 28px; color: #ffffff; font-weight: bold; font-size: 14px;">N</div>
                    <span style="display: inline-block; vertical-align: middle; margin-left: 8px; font-weight: 700; font-size: 15px; letter-spacing: 0.12em; color: #111827;">NOVA</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- MAIN CARD -->
          <tr>
            <td class="content-cell" style="background-color: #ffffff; border-radius: 16px; padding: 36px 40px; box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04); border: 1px solid rgba(0, 0, 0, 0.05);">
              
              <!-- EMAIL BODY CONTENT -->
              ${styledBody}

            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td align="center" style="padding: 24px 16px; color: #9ca3af; font-size: 12px; line-height: 1.5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
              <p style="margin: 0 0 6px 0;">
                Sent to <span style="color: #6b7280; font-weight: 500;">${recipientEmail}</span> regarding <strong>${campaignName}</strong>
              </p>
              <p style="margin: 0 0 8px 0; color: #9ca3af;">
                &copy; ${currentYear} ${organization}. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
  ${trackingPixel}
</body>
</html>`;

  // 6. Plain text version
  const plainText = generatePlainText(body, recipient, campaign);

  return {
    subject: resolvedSubject,
    html: fullHtml,
    text: plainText,
  };
}

import crypto from "crypto";
import { EmailTrackingLink } from "../models/email-tracking-link.model.js";
import { EmailEvent } from "../models/email-event.model.js";
import { Mail } from "../models/mail.model.js";
import { toMysqlDateTime } from "./datetime.js";

const OPEN_DEBOUNCE_MS = 60_000;

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

function cleanBase(url) {
  return String(url || "").trim().replace(/\/$/, "");
}

function isTrackableBase(url) {
  const base = cleanBase(url);
  if (!base) return false;
  if (!/^https:\/\//i.test(base)) return false;
  if (/localhost|127\.0\.0\.1/i.test(base)) return false;
  return true;
}

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function shouldSkipHref(href) {
  const value = String(href || "").trim();
  if (!value) return true;
  if (/^(mailto:|tel:|#|javascript:)/i.test(value)) return true;
  if (/\/api\/track(?:ing)?\//i.test(value)) return true;
  if (/unsubscribe/i.test(value)) return true;
  if (!/^https?:\/\//i.test(value)) return true;
  return false;
}

function stripExistingOpenPixels(html) {
  return String(html || "").replace(
    /<img\b[^>]*\/api\/track(?:ing)?\/open\/[^>]*>/gi,
    ""
  );
}

export async function prepareEmailTracking(html, mailContext = {}) {
  const {
    mailId,
    campaignId = null,
    leadId = null,
    apiBaseUrl = "",
  } = mailContext;

  const base = cleanBase(apiBaseUrl);
  if (!html || !mailId || !isTrackableBase(base)) {
    console.warn(
      `[tracking] skipped prepareEmailTracking mailId=${mailId || "none"} base=${base || "none"}`
    );
    return { html: html || "", openToken: null, clickTokens: [] };
  }

  let workingHtml = stripExistingOpenPixels(html);
  const clickTokens = [];
  const campId = campaignId != null ? Number(campaignId) : null;

  const openExisting = await EmailTrackingLink.findOpenTokenForMail(mailId);
  let openToken = openExisting?.tracking_token || null;
  if (!openToken) {
    openToken = newToken();
    await EmailTrackingLink.create({
      mailId,
      campaignId: campId,
      leadId,
      trackingToken: openToken,
      originalUrl: null,
      linkType: "open",
    });
  }

  workingHtml = workingHtml.replace(
    /<a\s+([^>]*?)href=(["'])(.*?)\2([^>]*?)>/gi,
    (match, prefix, quote, href, suffix) => {
      if (shouldSkipHref(href)) return match;
      if (!isSafeHttpUrl(href)) return match;
      const token = newToken();
      clickTokens.push({ token, originalUrl: href });
      const tracked = campId
        ? `${base}/api/tracking/click/${campId}/${mailId}?url=${encodeURIComponent(href)}&t=${token}`
        : `${base}/api/tracking/click/${mailId}?url=${encodeURIComponent(href)}&t=${token}`;
      return `<a ${prefix}href=${quote}${tracked}${quote}${suffix}>`;
    }
  );

  for (const item of clickTokens) {
    await EmailTrackingLink.create({
      mailId,
      campaignId: campId,
      leadId,
      trackingToken: item.token,
      originalUrl: item.originalUrl,
      linkType: "click",
    });
  }

  const openSrc = campId
    ? `${base}/api/tracking/open/${campId}/${mailId}?t=${openToken}`
    : `${base}/api/tracking/open/${mailId}?t=${openToken}`;

  const pixel = `<img src="${openSrc}" width="1" height="1" alt="" border="0" style="width:1px;height:1px;border:0;outline:none;text-decoration:none;display:block;" />`;
  if (/<\/body>/i.test(workingHtml)) {
    workingHtml = workingHtml.replace(/<\/body>/i, `${pixel}</body>`);
  } else {
    workingHtml = `${workingHtml}${pixel}`;
  }

  console.log(
    `[tracking] prepared mailId=${mailId} campaignId=${campId} open=${openSrc} clicks=${clickTokens.length}`
  );

  return { html: workingHtml, openToken, clickTokens };
}

export async function recordTrackingEvent({
  campaignId,
  mailId,
  eventType,
  url = null,
  trackingToken = null,
  userAgent = null,
  ipAddress = null,
}) {
  if (!mailId || !eventType) return null;
  const campId = campaignId != null ? Number(campaignId) : null;
  if (!campId) return null;
  try {
    return await EmailEvent.create({
      campaignId: campId,
      recipientId: Number(mailId),
      eventType,
      url,
      trackingToken,
      userAgent,
      ipAddress,
    });
  } catch (err) {
    console.warn("[tracking] event insert failed:", err.message);
    return null;
  }
}

export async function recordMailDelivered(mailId, campaignId) {
  await recordTrackingEvent({
    campaignId,
    mailId,
    eventType: "delivered",
  });
  await recordTrackingEvent({
    campaignId,
    mailId,
    eventType: "sent",
  });
}

export async function handleTrackedOpen({ token, mailId, campaignId, userAgent, ipAddress }) {
  let mail = null;
  let resolvedCampaignId = campaignId ? Number(campaignId) : null;
  let trackingToken = token || null;

  if (token && isTrackingToken(token) && !mailId) {
    const link = await EmailTrackingLink.findByToken(token);
    if (!link || link.link_type !== "open") return { ok: false };
    mail = await Mail.findById(link.mail_id);
    resolvedCampaignId = link.campaign_id || resolvedCampaignId;
    trackingToken = link.tracking_token;
  } else if (mailId) {
    mail = await Mail.findById(mailId);
    resolvedCampaignId = resolvedCampaignId || (mail ? Number(mail.campaign_id) : null);
    if (token && isTrackingToken(token)) trackingToken = token;
  }

  if (!mail) return { ok: false };

  const now = Date.now();
  const lastOpenMs = mail.last_opened_at ? new Date(mail.last_opened_at).getTime() : 0;
  const isDuplicateBurst = lastOpenMs > 0 && now - lastOpenMs < OPEN_DEBOUNCE_MS;

  if (!isDuplicateBurst) {
    const isFirstOpen = !mail.first_opened_at && (!mail.open_count || Number(mail.open_count) === 0);
    const mysqlNow = toMysqlDateTime(new Date(now));
    const nextOpenCount = (Number(mail.open_count) || 0) + 1;
    const deliveryStatus = mail.delivery_status === "failed" ? "failed" : "opened";
    const updateFields = {
      open_count: nextOpenCount,
      last_opened_at: mysqlNow,
      delivery_status: deliveryStatus,
      status: 1,
    };
    if (isFirstOpen) updateFields.first_opened_at = mysqlNow;
    if (!mail.sent_at) updateFields.sent_at = mysqlNow;
    await Mail.updateById(mail.id, updateFields);

    await recordTrackingEvent({
      campaignId: resolvedCampaignId || mail.campaign_id,
      mailId: mail.id,
      eventType: "open",
      trackingToken,
      userAgent,
      ipAddress,
    });
    console.log(`[TrackOpen] mail=${mail.id} open#${nextOpenCount}`);
  }

  return { ok: true, mailId: mail.id, debounced: isDuplicateBurst };
}

export async function handleTrackedClick({ token, mailId, campaignId, fallbackUrl, userAgent, ipAddress }) {
  let originalUrl = null;
  let mail = null;
  let resolvedCampaignId = campaignId ? Number(campaignId) : null;
  let trackingToken = token || null;

  if (token && isTrackingToken(token) && !mailId) {
    const link = await EmailTrackingLink.findByToken(token);
    if (!link || link.link_type !== "click") return { ok: false, redirectTo: null };
    if (!link.original_url || !isSafeHttpUrl(link.original_url)) {
      return { ok: false, redirectTo: null };
    }
    originalUrl = link.original_url;
    mail = await Mail.findById(link.mail_id);
    resolvedCampaignId = link.campaign_id || resolvedCampaignId;
    trackingToken = link.tracking_token;
  } else if (mailId) {
    mail = await Mail.findById(mailId);
    const fromQuery = fallbackUrl && isSafeHttpUrl(fallbackUrl) ? fallbackUrl : null;
    if (fromQuery) {
      originalUrl = fromQuery;
    } else if (token && isTrackingToken(token)) {
      const link = await EmailTrackingLink.findByToken(token);
      if (link?.original_url && isSafeHttpUrl(link.original_url)) {
        originalUrl = link.original_url;
        trackingToken = link.tracking_token;
      }
    }
    resolvedCampaignId = resolvedCampaignId || (mail ? Number(mail.campaign_id) : null);
  }

  if (!mail || !originalUrl || !isSafeHttpUrl(originalUrl)) {
    return { ok: false, redirectTo: null };
  }

  const mysqlNow = toMysqlDateTime(new Date());
  const nextClickCount = (Number(mail.click_count) || 0) + 1;
  const nextOpenCount = Math.max(1, Number(mail.open_count) || 1);
  const deliveryStatus = mail.delivery_status === "failed" ? "failed" : "opened";
  const updateFields = {
    click_count: nextClickCount,
    open_count: nextOpenCount,
    delivery_status: deliveryStatus,
    status: 1,
  };
  if (!mail.first_opened_at) updateFields.first_opened_at = mysqlNow;
  if (!mail.last_opened_at) updateFields.last_opened_at = mysqlNow;
  if (!mail.sent_at) updateFields.sent_at = mysqlNow;
  await Mail.updateById(mail.id, updateFields);

  await recordTrackingEvent({
    campaignId: resolvedCampaignId || mail.campaign_id,
    mailId: mail.id,
    eventType: "click",
    url: originalUrl,
    trackingToken,
    userAgent,
    ipAddress,
  });

  console.log(`[TrackClick] mail=${mail.id} -> ${originalUrl}`);
  return { ok: true, redirectTo: originalUrl };
}

export function isTrackingToken(value) {
  return /^[a-f0-9]{32,64}$/i.test(String(value || ""));
}

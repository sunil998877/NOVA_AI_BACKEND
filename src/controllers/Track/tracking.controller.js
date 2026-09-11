import { Mail } from "../../models/mail.model.js";
import { EmailEvent } from "../../models/email-event.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { toMysqlDateTime } from "../../utils/datetime.js";

const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded && typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || null;
}

function sanitizeRedirectUrl(target) {
  if (!target || typeof target !== "string") {
    return "/";
  }
  try {
    const parsed = new URL(target);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch { }
  return "/";
}

export const trackOpen = asyncHandler(async (req, res) => {
  const campaignId = req.params.campaignId;
  const recipientId = req.params.recipientId || req.params.mailId;

  if (recipientId) {
    try {
      const mail = await Mail.findById(recipientId);
      if (mail) {
        const candidateCampId = campaignId && !Number.isNaN(Number(campaignId)) ? Number(campaignId) : Number(mail.campaign_id);
        const actualCampaignId = Number.isInteger(candidateCampId) && candidateCampId > 0 ? candidateCampId : null;

        const isFirstOpen = !mail.first_opened_at && (!mail.open_count || Number(mail.open_count) === 0);
        const now = new Date();
        const mysqlNow = toMysqlDateTime(now);
        const nextOpenCount = (Number(mail.open_count) || 0) + 1;
        const deliveryStatus = mail.delivery_status === "failed" ? "failed" : "opened";

        const updateFields = {
          open_count: nextOpenCount,
          last_opened_at: mysqlNow,
          delivery_status: deliveryStatus,
          status: 1,
        };
        if (isFirstOpen) {
          updateFields.first_opened_at = mysqlNow;
        }
        if (!mail.sent_at) {
          updateFields.sent_at = mysqlNow;
        }

        await Mail.updateById(mail.id, updateFields);
        console.log(`[TrackOpen] Mail ID ${mail.id} (${mail.email}) recorded open #${nextOpenCount} for campaign ${actualCampaignId}`);

        if (actualCampaignId) {
          try {
            await EmailEvent.create({
              campaignId: actualCampaignId,
              recipientId: mail.id,
              eventType: "open",
              url: null,
              userAgent: req.get("user-agent") || null,
              ipAddress: getClientIp(req),
            });
          } catch (eventErr) {
            console.warn("[TrackOpen] EmailEvent record skipped:", eventErr.message);
          }
        }
      }
    } catch (err) {
      console.error("[TrackOpen] Error:", err.message);
    }
  }

  res.set({
    "Content-Type": "image/gif",
    "Content-Length": TRANSPARENT_GIF.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Access-Control-Allow-Origin": "*",
    "ngrok-skip-browser-warning": "1",
  });
  return res.end(TRANSPARENT_GIF);
});

export const trackClick = asyncHandler(async (req, res) => {
  const campaignId = req.params.campaignId;
  const recipientId = req.params.recipientId || req.params.mailId;
  const targetUrl = req.query.url;

  if (recipientId) {
    try {
      const mail = await Mail.findById(recipientId);
      if (mail) {
        const candidateCampId = campaignId && !Number.isNaN(Number(campaignId)) ? Number(campaignId) : Number(mail.campaign_id);
        const actualCampaignId = Number.isInteger(candidateCampId) && candidateCampId > 0 ? candidateCampId : null;

        const now = new Date();
        const mysqlNow = toMysqlDateTime(now);
        const nextClickCount = (Number(mail.click_count) || 0) + 1;
        const nextOpenCount = Math.max(1, Number(mail.open_count) || 1);
        const deliveryStatus = mail.delivery_status === "failed" ? "failed" : "opened";

        const updateFields = {
          click_count: nextClickCount,
          open_count: nextOpenCount,
          delivery_status: deliveryStatus,
          status: 1,
        };
        if (!mail.first_opened_at) {
          updateFields.first_opened_at = mysqlNow;
        }
        if (!mail.last_opened_at) {
          updateFields.last_opened_at = mysqlNow;
        }
        if (!mail.sent_at) {
          updateFields.sent_at = mysqlNow;
        }

        await Mail.updateById(mail.id, updateFields);
        console.log(`[TrackClick] Mail ID ${mail.id} (${mail.email}) recorded click #${nextClickCount} on ${targetUrl}`);

        if (actualCampaignId) {
          try {
            await EmailEvent.create({
              campaignId: actualCampaignId,
              recipientId: mail.id,
              eventType: "click",
              url: targetUrl || null,
              userAgent: req.get("user-agent") || null,
              ipAddress: getClientIp(req),
            });
          } catch (eventErr) {
            console.warn("[TrackClick] EmailEvent record skipped:", eventErr.message);
          }
        }
      }
    } catch (err) {
      console.error("[TrackClick] Error:", err.message);
    }
  }

  const destination = sanitizeRedirectUrl(targetUrl);
  res.set({
    "Access-Control-Allow-Origin": "*",
    "ngrok-skip-browser-warning": "1",
  });
  return res.redirect(302, destination);
});

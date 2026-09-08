import { Mail } from "../../models/mail.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

export const trackOpen = asyncHandler(async (req, res) => {
  const mailId = req.params.mailId;

  if (mailId) {
    try {
      const mail = await Mail.findById(mailId);
      if (mail) {
        const nextOpenCount = (Number(mail.open_count) || 0) + 1;
        const deliveryStatus =
          mail.delivery_status === "failed" ? "failed" : "opened";

        await Mail.updateById(mail.id, {
          open_count: nextOpenCount,
          delivery_status: deliveryStatus,
        });
      }
    } catch (err) {
      console.error("[Track] Error recording open for mail:", mailId, err.message);
    }
  }

  res.set({
    "Content-Type": "image/gif",
    "Content-Length": TRANSPARENT_GIF.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  return res.end(TRANSPARENT_GIF);
});

export const trackClick = asyncHandler(async (req, res) => {
  const mailId = req.params.mailId;
  const targetUrl = req.query.url;

  if (mailId) {
    try {
      const mail = await Mail.findById(mailId);
      if (mail) {
        const deliveryStatus =
          mail.delivery_status === "failed" ? "failed" : "opened";
        const nextOpenCount = Math.max(1, (Number(mail.open_count) || 0));

        await Mail.updateById(mail.id, {
          delivery_status: deliveryStatus,
          open_count: nextOpenCount,
        });
      }
    } catch (err) {
      console.error("[Track] Error recording click for mail:", mailId, err.message);
    }
  }

  if (!targetUrl) {
    return res.redirect("/");
  }

  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return res.redirect(302, targetUrl);
    }
  } catch {
    // fallback
  }

  return res.redirect(302, "/");
});

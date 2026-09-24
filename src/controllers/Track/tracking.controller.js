import {
  handleTrackedOpen,
  handleTrackedClick,
  isTrackingToken,
} from "../../utils/emailTracking.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

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

function sendPixel(res) {
  res.set({
    "Content-Type": "image/gif",
    "Content-Length": TRANSPARENT_GIF.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "Access-Control-Allow-Origin": "*",
  });
  return res.end(TRANSPARENT_GIF);
}

export const trackOpen = asyncHandler(async (req, res) => {
  try {
    const userAgent = req.get("user-agent") || null;
    const ipAddress = getClientIp(req);
    const qToken = typeof req.query.t === "string" ? req.query.t : null;

    if (req.params.recipientId) {
      await handleTrackedOpen({
        mailId: req.params.recipientId,
        campaignId: req.params.campaignId,
        token: qToken,
        userAgent,
        ipAddress,
      });
    } else {
      const single = req.params.token;
      if (isTrackingToken(single)) {
        await handleTrackedOpen({ token: single, userAgent, ipAddress });
      } else if (single) {
        await handleTrackedOpen({
          mailId: single,
          token: qToken,
          userAgent,
          ipAddress,
        });
      }
    }
  } catch (err) {
    console.error("[TrackOpen] Error:", err.message);
  }

  return sendPixel(res);
});

export const trackClick = asyncHandler(async (req, res) => {
  let redirectTo = "/";
  try {
    const userAgent = req.get("user-agent") || null;
    const ipAddress = getClientIp(req);
    const qToken = typeof req.query.t === "string" ? req.query.t : null;
    let result;

    if (req.params.recipientId) {
      result = await handleTrackedClick({
        mailId: req.params.recipientId,
        campaignId: req.params.campaignId,
        fallbackUrl: req.query.url,
        token: qToken,
        userAgent,
        ipAddress,
      });
    } else {
      const single = req.params.token;
      if (isTrackingToken(single)) {
        result = await handleTrackedClick({ token: single, userAgent, ipAddress });
      } else if (single) {
        result = await handleTrackedClick({
          mailId: single,
          fallbackUrl: req.query.url,
          token: qToken,
          userAgent,
          ipAddress,
        });
      }
    }

    if (result?.redirectTo) redirectTo = result.redirectTo;
  } catch (err) {
    console.error("[TrackClick] Error:", err.message);
  }

  res.set({ "Access-Control-Allow-Origin": "*" });
  return res.redirect(302, redirectTo);
});

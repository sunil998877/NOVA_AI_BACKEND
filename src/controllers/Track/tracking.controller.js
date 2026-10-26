import {
  handleTrackedOpen,
  handleTrackedClick,
  isTrackingToken,
} from "../../utils/emailTracking.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { Mail } from "../../models/mail.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { Lead } from "../../models/lead.model.js";
import { User } from "../../models/user.model.js";
import { OrchestratorService } from "../../services/ase/orchestrator.service.js";
import { detectEmailScanner } from "../../utils/emailScannerDetector.js";
import { eventBus } from "../../services/ase/eventBus.service.js";

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

export const trackAseOpen = asyncHandler(async (req, res) => {
  try {
    const leadId = Number(req.params.leadId);
    const token = typeof req.query.t === "string" ? req.query.t : null;
    const userAgent = req.get("user-agent") || null;
    const ipAddress = getClientIp(req);
    const lead = leadId ? await Lead.findById(leadId) : null;
    const storedToken = lead?.metadata?.outreach_open_token;
    const tokenOk = Boolean(storedToken && token && token === storedToken);
    if (lead && tokenOk) {
      const scannerResult = detectEmailScanner(userAgent, ipAddress);
      console.log(`[TrackAseOpen] lead=${lead.id} scanner=${scannerResult.isScanner || false}`);
      await eventBus.publish("EMAIL_OPENED", {
        organization_id: lead.organization_id || 1,
        lead_id: lead.id,
        channel: "EMAIL",
        status: "OPENED",
        source: scannerResult.isScanner ? "PRIVACY_PROXY" : "EMAIL_PIXEL",
        payload: {
          is_scanner: scannerResult.isScanner,
          scanner_type: scannerResult.scannerType,
          user_agent: userAgent,
          ip_address: ipAddress,
          opened_at: new Date().toISOString(),
        },
        idempotency_key: `ase_open_${lead.id}`,
      });
      await OrchestratorService.handleEmailOpen(lead, {
        mailId: `ase_${lead.id}`,
        isScanner: scannerResult.isScanner,
        scannerType: scannerResult.scannerType,
        userAgent,
        ipAddress,
        isFirstOpen: true,
      });
    }
  } catch (err) {
    console.error("[TrackAseOpen] Error:", err.message);
  }
  return sendPixel(res);
});

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

async function resolveMailOrgId(mail) {
  if (!mail) return null;
  if (mail.organization_id) return Number(mail.organization_id);
  if (mail.user_id) {
    const user = await User.findById(mail.user_id).catch(() => null);
    if (user?.organization_id) return Number(user.organization_id);
  }
  return null;
}

export const trackUnsubscribe = asyncHandler(async (req, res) => {
  const mailId = req.params.mailId || req.params.recipientId;
  let email = req.query.email ? String(req.query.email).toLowerCase().trim() : "";
  let orgId = null;

  if (mailId) {
    try {
      const mail = await Mail.findById(mailId);
      if (mail && mail.email) {
        email = mail.email.toLowerCase().trim();
      }
      orgId = await resolveMailOrgId(mail);
    } catch (_) { }
  }

  if (email && orgId) {
    try {
      await Suppression.add(orgId, "EMAIL", email, "Unsubscribed via email link");
      const existingLead = await Lead.findByEmail(orgId, email);
      if (existingLead) {
        await Lead.updateById(
          existingLead.id,
          { status: "SUPPRESSED_DNC", do_not_contact: 1, next_action: null, next_action_time: null },
          orgId
        );
      }
    } catch (_) { }
  }

  res.set({ "Content-Type": "text/html; charset=utf-8" });
  return res.status(200).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Unsubscribed</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background-color: #f8fafc; color: #0f172a; }
          .card { background: white; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); max-width: 420px; text-align: center; border: 1px solid #e2e8f0; }
          h1 { font-size: 1.5rem; margin-bottom: 0.75rem; color: #0f172a; }
          p { color: #64748b; font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; }
          .badge { display: inline-block; padding: 0.35rem 0.75rem; background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; border-radius: 9999px; font-size: 0.85rem; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">Preferences Updated</div>
          <h1>You have been unsubscribed</h1>
          <p>${email ? `<b>${email}</b> will no longer receive marketing emails from this sender.` : "You will no longer receive marketing communications."}</p>
        </div>
      </body>
    </html>
  `);
});

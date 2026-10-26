import crypto from "crypto";
import { BaseChannelAdapter } from "./base.adapter.js";
import { unifiedDeliveryService } from "../../email/unifiedDelivery.service.js";
import { env } from "../../../config/env.js";
import { draftCompanyPersonalizedEmail } from "../leadEmailDrafter.service.js";
import { Lead } from "../../../models/lead.model.js";
import { LeadEvent } from "../../../models/lead-event.model.js";
import { resolvePublicBaseUrl } from "../../../utils/publicBaseUrl.js";
import { sanitizeOutreachEmail } from "../../../utils/outreachEmail.js";

function attachOpenPixel(html, leadId, token, baseUrl) {
    const src = `${baseUrl}/api/tracking/open/ase/${leadId}?t=${token}`;
    const pixel = `<img src="${src}" width="1" height="1" alt="" border="0" style="width:1px;height:1px;border:0;outline:none;text-decoration:none;display:block;" />`;
    const body = html || "";
    if (/<\/body>/i.test(body)) return body.replace(/<\/body>/i, `${pixel}</body>`);
    return `${body}${pixel}`;
}

export class NovaEmailAdapter extends BaseChannelAdapter {
    constructor() {
        super("EMAIL");
    }

    async execute(lead, action, payload = {}) {
        if (!lead.email) {
            return {
                channel: "EMAIL",
                status: "FAILED",
                error: "Lead has no email address",
                rawResponse: null,
            };
        }

        const domain = (lead.email.split("@")[1] || "").toLowerCase();
        const reservedDomains = ["example.com", "example.net", "example.org", "test", "invalid", "localhost"];

        const senderEmail = payload.from || env.novaSenderEmail || "outreach@nova-sales.internal";
        const senderName = payload.senderName || env.novaSenderName || "NOVA AI";
        const fromAddress = `"${senderName}" <${senderEmail}>`;

        const currentMeta = { ...(typeof lead.metadata === "object" && lead.metadata ? lead.metadata : {}) };
        const storedEmail = currentMeta.outreach_email
            ? sanitizeOutreachEmail(currentMeta.outreach_email, senderName)
            : null;

        let subject = payload.subject || storedEmail?.subject;
        let bodyText = payload.text || storedEmail?.text;
        let bodyHtml = payload.html || storedEmail?.html;
        let companyResearch = payload.research || currentMeta.company_research || null;

        if (!subject || (!bodyHtml && !bodyText)) {
            const drafted = await draftCompanyPersonalizedEmail(lead, { senderName, senderEmail });
            subject = subject || drafted.subject;
            bodyText = bodyText || drafted.text;
            bodyHtml = bodyHtml || drafted.html;
            companyResearch = drafted.research || companyResearch;
        }

        if (subject && (bodyText || bodyHtml)) {
            const cleaned = sanitizeOutreachEmail({ subject, text: bodyText, html: bodyHtml }, senderName);
            subject = cleaned.subject;
            bodyText = cleaned.text;
            bodyHtml = cleaned.html;
        }

        if (lead.id && subject && (bodyText || bodyHtml) && !storedEmail?.subject) {
            currentMeta.outreach_email = {
                subject,
                text: bodyText,
                html: bodyHtml,
                written_at: new Date().toISOString(),
                is_edited: false,
            };
            currentMeta.outreach_status = "ready";
        }

        if (!bodyHtml && bodyText) {
            bodyHtml = `<p>${String(bodyText).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
        }

        const openToken = currentMeta.outreach_open_token || crypto.randomBytes(24).toString("hex");
        const trackingBase = await resolvePublicBaseUrl();
        if (lead.id) {
            bodyHtml = attachOpenPixel(bodyHtml, lead.id, openToken, trackingBase);
            try {
                await Lead.updateById(
                    lead.id,
                    {
                        metadata: {
                            ...currentMeta,
                            company_research: companyResearch || currentMeta.company_research || null,
                            outreach_email: currentMeta.outreach_email || {
                                subject,
                                text: bodyText,
                                html: bodyHtml,
                                written_at: new Date().toISOString(),
                            },
                            outreach_status: "ready",
                            outreach_open_token: openToken,
                        },
                    },
                    lead.organization_id || 1
                );
            } catch (_) {}
        }

        if (lead.id && companyResearch && !currentMeta.company_research) {
            try {
                await LeadEvent.create({
                    organization_id: lead.organization_id || 1,
                    lead_id: lead.id,
                    user_id: lead.user_id || null,
                    channel: "AI_RESEARCH",
                    event_type: "COMPANY_RESEARCHED",
                    status: "COMPLETED",
                    payload: {
                        company: companyResearch.company,
                        summary: companyResearch.summary,
                        coreServices: companyResearch.coreServices,
                        industry: companyResearch.industry,
                        targetAudience: companyResearch.targetAudience,
                        growthOpportunity: companyResearch.growthOpportunity,
                        source: companyResearch.source,
                    },
                });
            } catch (_) { }
        }

        if (reservedDomains.includes(domain)) {
            const simulatedId = `sim_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            return {
                channel: "EMAIL",
                status: "SUCCEEDED",
                rawResponse: {
                    simulated: true,
                    messageId: simulatedId,
                    domain,
                    note: `Simulated outreach delivery for ${domain}`,
                },
                metadata: {
                    messageId: simulatedId,
                    to: lead.email,
                    subject,
                    research: companyResearch,
                    simulated: true,
                },
            };
        }

        try {
            const idempotencyKey = payload.idempotencyKey || `ase_lead_${lead.id}_email_${Date.now()}`;
            const result = await unifiedDeliveryService.deliverSingle({
                orgId: lead.organization_id || 1,
                to: lead.email,
                subject,
                html: bodyHtml,
                text: bodyText,
                fromAddress,
                replyTo: payload.replyTo || senderEmail,
                leadId: lead.id,
                idempotencyKey,
            });

            if (result.status === "SUCCEEDED") {
                return {
                    channel: "EMAIL",
                    status: "SUCCEEDED",
                    rawResponse: result,
                    metadata: {
                        messageId: result.messageId || `nova-email-${Date.now()}`,
                        to: lead.email,
                        subject,
                        research: companyResearch,
                        senderAccountId: result.senderAccountId,
                    },
                };
            }

            if (result.status === "SKIPPED") {
                return {
                    channel: "EMAIL",
                    status: "FAILED",
                    error: `Compliance gate blocked delivery: ${result.skipReason}`,
                    rawResponse: result,
                };
            }

            return {
                channel: "EMAIL",
                status: "FAILED",
                error: result.error || "Delivery failed",
                rawResponse: result,
            };
        } catch (error) {
            return {
                channel: "EMAIL",
                status: "FAILED",
                error: error.message,
                rawResponse: null,
            };
        }
    }
}

export const emailAdapter = new NovaEmailAdapter();

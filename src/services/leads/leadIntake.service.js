import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { OrchestratorService } from "../ase/orchestrator.service.js";

export const LEAD_SOURCES = Object.freeze({
    API: "API",
    CSV: "CSV_IMPORT",
    CRM_HUBSPOT: "CRM_HUBSPOT",
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CLEAN_REGEX = /[^\d+]/g;
const MAX_BATCH = 5000;

const clean = (value, max = 255) => {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? text.slice(0, max) : null;
};

const normalizeTags = (tags) => {
    if (!tags) return [];
    const list = Array.isArray(tags) ? tags : String(tags).split(/[,;|]/);
    return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))].slice(0, 25);
};

export function normalizeLead(raw = {}) {
    const email = clean(raw.email)?.toLowerCase();
    if (!email) throw new Error("Email is required");
    if (!EMAIL_REGEX.test(email)) throw new Error(`Invalid email: ${email}`);

    const first = clean(raw.firstName || raw.first_name);
    const last = clean(raw.lastName || raw.last_name);
    const name = clean(raw.name || raw.fullName || raw.full_name) || [first, last].filter(Boolean).join(" ") || null;

    let phone = clean(raw.phone || raw.mobile, 64);
    if (phone) {
        phone = phone.replace(PHONE_CLEAN_REGEX, "");
    }

    const priority = Number(raw.priority) || 50;

    const emailConsent = raw.emailConsent || raw.email_consent || {
        status: raw.consentEmail === false ? "DENIED" : "GRANTED",
        source: raw.source || "INGESTION",
        timestamp: new Date().toISOString(),
    };

    const voiceConsent = raw.voiceConsent || raw.voice_consent || {
        status: raw.consentVoice === false ? "DENIED" : "GRANTED",
        source: raw.source || "INGESTION",
        timestamp: new Date().toISOString(),
    };

    const whatsappConsent = raw.whatsappConsent || raw.whatsapp_consent || {
        status: "UNKNOWN",
        source: raw.source || "INGESTION",
        timestamp: new Date().toISOString(),
    };

    return {
        email,
        name,
        firstName: first,
        lastName: last,
        company: clean(raw.company || raw.organization),
        phone: phone || null,
        whatsapp_number: clean(raw.whatsappNumber || raw.whatsapp_number, 64),
        tags: normalizeTags(raw.tags),
        externalId: clean(raw.externalId || raw.external_id, 128),
        priority,
        email_consent: emailConsent,
        voice_consent: voiceConsent,
        whatsapp_consent: whatsappConsent,
        segment_attributes: raw.segmentAttributes || raw.segment_attributes || {},
        metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {},
    };
}

export async function processLead(rawLead, { organizationId = 1, userId = null, source = "API", updateExisting = false, matchDomain = false }) {
    if (!organizationId) throw new Error("organizationId is required to ingest a lead");
    const data = normalizeLead(rawLead);

    const domain = data.email.split("@")[1];
    const isSuppressed = await Suppression.isSuppressed(organizationId, {
        email: data.email,
        phone: data.phone,
        domain,
    });

    let existing =
        (await Lead.findByEmail(organizationId, data.email)) ||
        (data.phone ? await Lead.findByPhone(organizationId, data.phone) : null) ||
        (data.externalId ? await Lead.findByExternalId(organizationId, source, data.externalId) : null);

    if (!existing && matchDomain && domain) {
        existing = await Lead.findByDomain(organizationId, domain);
    }

    if (existing) {
        if (!updateExisting) {
            await LeadEvent.create({
                organization_id: organizationId,
                lead_id: existing.id,
                user_id: userId,
                channel: "SYSTEM",
                event_type: "LEAD_DEDUPLICATED",
                status: "SKIPPED",
                payload: { email: data.email, phone: data.phone, reason: "duplicate_skipped" },
            });
            return { status: "skipped", reason: "duplicate", lead: existing };
        }

        const mergedTags = [...new Set([...(existing.tags || []), ...data.tags])];
        const updated = await Lead.updateById(
            existing.id,
            {
                name: data.name ?? existing.name,
                first_name: data.firstName ?? existing.first_name,
                last_name: data.lastName ?? existing.last_name,
                company: data.company ?? existing.company,
                phone: data.phone ?? existing.phone,
                whatsapp_number: data.whatsapp_number ?? existing.whatsapp_number,
                tags: mergedTags,
                external_id: data.externalId ?? existing.external_id,
                metadata: { ...(existing.metadata || {}), ...data.metadata },
                segment_attributes: { ...(existing.segment_attributes || {}), ...data.segment_attributes },
            },
            organizationId
        );

        await LeadEvent.create({
            organization_id: organizationId,
            lead_id: existing.id,
            user_id: userId,
            channel: "SYSTEM",
            event_type: "LEAD_DEDUPLICATED",
            status: "MERGED",
            payload: { email: data.email, updatedFields: Object.keys(data) },
        });

        return { status: "updated", lead: updated };
    }

    const initialStatus = isSuppressed ? "SUPPRESSED_DNC" : "NEW";
    const doNotContact = isSuppressed ? 1 : 0;

    const lead = await Lead.create({
        ...data,
        organization_id: organizationId,
        userId,
        source,
        status: initialStatus,
        do_not_contact: doNotContact,
    });

    await LeadEvent.create({
        organization_id: organizationId,
        lead_id: lead.id,
        user_id: userId,
        channel: "SYSTEM",
        event_type: "LEAD_CREATED",
        status: initialStatus,
        payload: { source, priority: lead.priority, isSuppressed: Boolean(isSuppressed) },
    });

    if (isSuppressed) {
        await LeadEvent.create({
            organization_id: organizationId,
            lead_id: lead.id,
            user_id: userId,
            channel: "SYSTEM",
            event_type: "LEAD_SUPPRESSED",
            status: "SUPPRESSED_DNC",
            payload: { reason: isSuppressed.reason || "Matched DNC list" },
        });
    }

    let finalLead = lead;
    if (!isSuppressed) {
        try {
            const decision = await OrchestratorService.evaluateNextAction(lead);
            if (decision && decision.action) {
                finalLead = await Lead.updateById(
                    lead.id,
                    {
                        next_action: decision.action,
                        next_action_time: decision.scheduledTime,
                        status: "QUEUED",
                    },
                    organizationId
                );
                await LeadEvent.create({
                    organization_id: organizationId,
                    lead_id: lead.id,
                    user_id: userId,
                    channel: "SYSTEM",
                    event_type: "ORCHESTRATOR_DECISION",
                    status: "SCHEDULED",
                    payload: { nextAction: decision.action, at: decision.scheduledTime },
                });
            }
        } catch (_) {}
    }

    return { status: "created", lead: finalLead };
}

export async function processBatch(rawLeads, options) {
    const rows = Array.isArray(rawLeads) ? rawLeads.slice(0, MAX_BATCH) : [];
    const summary = {
        total: rows.length,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        truncated: Array.isArray(rawLeads) && rawLeads.length > MAX_BATCH,
    };

    for (let i = 0; i < rows.length; i++) {
        try {
            const result = await processLead(rows[i], options);
            summary[result.status] += 1;
        } catch (error) {
            summary.failed += 1;
            if (summary.errors.length < 100) {
                summary.errors.push({ row: i + 1, email: rows[i]?.email ?? null, error: error.message });
            }
        }
    }

    return summary;
}

export const LeadIntakeService = { processLead, processBatch, normalizeLead, LEAD_SOURCES };

import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { OrchestratorService } from "../ase/orchestrator.service.js";
import { enqueueLeadCompanyResearch } from "./companyResearchQueue.js";
import { eventBus } from "../ase/eventBus.service.js";
import { query } from "../../config/db.js";
import { followUpEngine } from "../followup/followUpEngine.service.js";
import { consentFromIntake, isConsentGranted } from "../ase/consent.service.js";
import { recordLeadConsentSnapshot } from "../ase/consentAudit.service.js";

export const LEAD_SOURCES = Object.freeze({
    API: "API",
    CSV: "CSV_IMPORT",
    CRM_HUBSPOT: "CRM_HUBSPOT",
});

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CLEAN_REGEX = /[^\d+]/g;
export const MAX_BATCH = 5000;
const CONSUMER_EMAIL_DOMAINS = new Set([
    "gmail.com",
    "yahoo.com",
    "outlook.com",
    "hotmail.com",
    "icloud.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
    "live.com",
    "msn.com",
    "example.com",
    "example.org",
    "example.net",
    "test.com",
    "sample.com",
]);

const lockTails = new Map();

function acquireLock(key) {
    const prev = lockTails.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });
    const tail = prev.then(() => current);
    lockTails.set(key, tail);
    return prev.then(() => () => {
        release();
        if (lockTails.get(key) === tail) lockTails.delete(key);
    });
}

async function withLocks(keys, fn) {
    const ordered = [...new Set(keys.filter(Boolean))].sort();
    const releases = [];
    for (const key of ordered) {
        releases.push(await acquireLock(key));
    }
    try {
        return await fn();
    } finally {
        for (const release of releases.reverse()) release();
    }
}

const isDuplicateKey = (error) => error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;

const consentRecord = (explicit, flag, source) => consentFromIntake(explicit, flag, source);

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
        if (phone.replace(/\D/g, "").length < 7) {
            const error = new Error(`Invalid phone: ${phone}`);
            error.field = "phone";
            throw error;
        }
    }

    const priority = Number(raw.priority) || 50;
    const source = raw.source || "INGESTION";
    const emailConsent = consentRecord(raw.emailConsent || raw.email_consent, raw.consentEmail, source);
    const voiceConsent = consentRecord(raw.voiceConsent || raw.voice_consent, raw.consentVoice, source);

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

export async function processLead(rawLead, options = {}) {
    const {
        organizationId = 1,
        userId = null,
        source = "API",
        updateExisting = false,
        matchDomain = false,
        suppressedCache = null,
        existingCache = null,
    } = options;

    if (!organizationId) throw new Error("organizationId is required to ingest a lead");
    const data = normalizeLead(rawLead);
    const domain = data.email.split("@")[1];
    const companyDomain = domain && !CONSUMER_EMAIL_DOMAINS.has(domain) ? domain : null;
    const lockKeys = [
        `org:${organizationId}:email:${data.email}`,
        data.phone ? `org:${organizationId}:phone:${data.phone}` : null,
        matchDomain && companyDomain ? `org:${organizationId}:domain:${companyDomain}` : null,
    ];
    return withLocks(lockKeys, () => ingestLockedLead(data, {
        organizationId,
        userId,
        source,
        updateExisting,
        matchDomain: Boolean(matchDomain && companyDomain),
        domain,
        suppressedCache,
        existingCache,
        autoEnroll: options.autoEnroll,
        campaignId: options.campaignId,
        sequenceId: options.sequenceId,
        sentAt: options.sentAt,
    }));
}

async function ingestLockedLead(data, {
    organizationId,
    userId,
    source,
    updateExisting,
    matchDomain,
    domain,
    suppressedCache,
    existingCache,
    autoEnroll,
    campaignId,
    sequenceId,
    sentAt,
}) {

    let isSuppressed = false;
    if (suppressedCache) {
        if (
            suppressedCache.emails.has(data.email) ||
            (data.phone && suppressedCache.phones.has(data.phone)) ||
            (domain && suppressedCache.domains.has(domain))
        ) {
            isSuppressed = { reason: "Matched DNC list" };
        }
    } else {
        isSuppressed = await Suppression.isSuppressed(organizationId, {
            email: data.email,
            phone: data.phone,
            domain,
        });
    }

    let existing = null;
    if (existingCache && existingCache.has(data.email)) {
        existing = existingCache.get(data.email);
    }
    if (!existing) {
        existing =
            (await Lead.findByEmail(organizationId, data.email)) ||
            (data.phone ? await Lead.findByPhone(organizationId, data.phone) : null) ||
            (data.externalId ? await Lead.findByExternalId(organizationId, source, data.externalId) : null);

        if (!existing && matchDomain && domain) {
            existing = await Lead.findByDomain(organizationId, domain);
        }
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

    const isSuppressedBool = Boolean(isSuppressed);
    const doNotContact = isSuppressedBool ? 1 : 0;
    const emailAllowed = !isSuppressedBool && isConsentGranted(data.email_consent);

    const initialStatus = isSuppressedBool ? "SUPPRESSED_DNC" : emailAllowed ? "QUEUED" : "NEW";
    const nextAction = isSuppressedBool || !emailAllowed ? null : "EMAIL";
    const nextActionTime = nextAction ? new Date() : null;
    if (!isSuppressedBool) {
        data.metadata = { ...(data.metadata || {}), company_research_status: "pending" };
    }

    let lead;
    try {
        lead = await Lead.create({
            ...data,
            organization_id: organizationId,
            userId,
            source,
            status: initialStatus,
            do_not_contact: doNotContact,
            next_action: nextAction,
            next_action_time: nextActionTime,
        });
    } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const raced =
            (await Lead.findByEmail(organizationId, data.email)) ||
            (data.phone ? await Lead.findByPhone(organizationId, data.phone) : null);
        if (!raced) throw error;
        if (!updateExisting) {
            return { status: "skipped", reason: "duplicate", lead: raced };
        }
        const merged = await Lead.updateById(
            raced.id,
            {
                name: data.name ?? raced.name,
                first_name: data.firstName ?? raced.first_name,
                last_name: data.lastName ?? raced.last_name,
                company: data.company ?? raced.company,
                phone: data.phone ?? raced.phone,
                tags: [...new Set([...(raced.tags || []), ...data.tags])],
                metadata: { ...(raced.metadata || {}), ...data.metadata },
            },
            organizationId
        );
        return { status: "updated", reason: "duplicate", lead: merged };
    }

    await LeadEvent.create({
        organization_id: organizationId,
        lead_id: lead.id,
        user_id: userId,
        channel: "SYSTEM",
        event_type: "LEAD_CREATED",
        status: initialStatus,
        payload: { source, priority: lead.priority, isSuppressed: Boolean(isSuppressed) },
    });
    await recordLeadConsentSnapshot(lead, { organizationId, actorUserId: userId });

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
        return { status: "created", lead };
    }

    enqueueLeadCompanyResearch({ ...lead, organization_id: organizationId, user_id: userId });

    return {
        status: "created",
        lead,
        ...(emailAllowed ? {} : { outreachStatus: "held_for_consent" }),
    };
}

export async function processBatch(rawLeads, options = {}) {
    if (Array.isArray(rawLeads) && rawLeads.length > MAX_BATCH) {
        const error = new Error(`Batch exceeds maximum of ${MAX_BATCH} leads`);
        error.statusCode = 413;
        throw error;
    }
    const rows = Array.isArray(rawLeads) ? rawLeads : [];
    const orgId = Number(options.organizationId || 1);
    const summary = {
        total: rows.length,
        accepted: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        rejected: 0,
        failed: 0,
        errors: [],
        truncated: false,
        maxBatch: MAX_BATCH,
    };

    if (rows.length === 0) return summary;

    let suppressedCache = null;
    try {
        const suppressionList = await Suppression.list(orgId, { limit: 1000 });
        suppressedCache = {
            emails: new Set(suppressionList.filter((s) => s.type === "EMAIL").map((s) => String(s.value).toLowerCase().trim())),
            phones: new Set(suppressionList.filter((s) => s.type === "PHONE").map((s) => String(s.value).trim())),
            domains: new Set(suppressionList.filter((s) => s.type === "DOMAIN").map((s) => String(s.value).toLowerCase().trim())),
        };
    } catch (_) {}

    const existingCache = new Map();
    try {
        const emailSet = new Set();
        for (const row of rows) {
            if (row?.email && typeof row.email === "string") {
                const em = row.email.toLowerCase().trim();
                if (em) emailSet.add(em);
            }
        }
        const emailList = Array.from(emailSet);
        const CHUNK_SIZE = 100;
        for (let i = 0; i < emailList.length; i += CHUNK_SIZE) {
            const chunk = emailList.slice(i, i + CHUNK_SIZE);
            if (chunk.length > 0) {
                const placeholders = chunk.map(() => "?").join(",");
                const existingRows = await query(
                    `SELECT id, email, phone, external_id, name, first_name, last_name, company, tags, metadata, segment_attributes FROM leads WHERE organization_id = ? AND email IN (${placeholders})`,
                    [orgId, ...chunk]
                );
                for (const row of existingRows) {
                    if (row.email) {
                        existingCache.set(row.email.toLowerCase().trim(), row);
                    }
                }
            }
        }
    } catch (_) {}

    const CONCURRENCY = 12;
    let index = 0;

    const workers = new Array(CONCURRENCY).fill(null).map(async () => {
        while (index < rows.length) {
            const i = index++;
            const row = rows[i];
            try {
                const result = await processLead(row, {
                    ...options,
                    organizationId: orgId,
                    suppressedCache,
                    existingCache,
                });
                summary[result.status] += 1;
                if (result.status === "created") summary.accepted += 1;
                if (result.status === "created" && result.lead?.email) {
                    existingCache.set(result.lead.email.toLowerCase().trim(), result.lead);
                }
            } catch (error) {
                summary.failed += 1;
                summary.rejected += 1;
                if (summary.errors.length < 100) {
                    summary.errors.push({ row: i + 1, email: row?.email ?? null, error: error.message });
                }
            }
        }
    });

    await Promise.all(workers);
    return summary;
}

export const LeadIntakeService = { processLead, processBatch, normalizeLead, LEAD_SOURCES };

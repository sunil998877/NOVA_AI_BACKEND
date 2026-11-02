import { Lead } from "../../../models/lead.model.js";
import { query } from "../../../config/db.js";
import { cleanDomain, isUsableResearchProfile } from "../../ase/companyResearch.service.js";
import { researchLeadCompany } from "../../leads/companyResearchQueue.js";
import { storeOutreachDraft } from "../../ase/leadEmailDrafter.service.js";
import { enqueueEmailPersonalizationJob } from "../enqueue.js";
import { emitOrgEvent, publishAseEvent } from "../realtime.js";
import { setCachedResearch } from "../cache.service.js";

function readMetadata(lead) {
    if (!lead?.metadata) return {};
    if (typeof lead.metadata === "string") {
        try {
            return JSON.parse(lead.metadata);
        } catch {
            return {};
        }
    }
    return typeof lead.metadata === "object" ? lead.metadata : {};
}

async function reuseResearchForDomain(lead, research) {
    const domain = cleanDomain(lead.email ? lead.email.split("@")[1] : null);
    if (!domain || !isUsableResearchProfile(research)) return 0;
    const orgId = Number(lead.organization_id || 1);
    const rows = await query(
        `SELECT id, email, metadata FROM leads
         WHERE organization_id = ? AND id <> ? AND email LIKE ? AND do_not_contact = 0
         LIMIT 40`,
        [orgId, Number(lead.id), `%@${domain}`]
    );
    let reused = 0;
    for (const row of rows || []) {
        const suffix = String(row.email || "").split("@")[1] || "";
        if (cleanDomain(suffix) !== domain) continue;
        let meta = {};
        try {
            meta = typeof row.metadata === "string" ? JSON.parse(row.metadata || "{}") : (row.metadata || {});
        } catch {
            meta = {};
        }
        if (isUsableResearchProfile(meta.company_research)) continue;
        await Lead.updateById(row.id, {
            metadata: {
                ...meta,
                company_research: research,
                company_research_status: "ready",
                outreach_status: meta.outreach_email?.subject ? meta.outreach_status : "writing",
            },
        }, orgId);
        reused += 1;
        const queued = await enqueueEmailPersonalizationJob({ id: row.id, organization_id: orgId, user_id: lead.user_id || null }, research);
        if (!queued) {
            const sibling = await Lead.findById(row.id, orgId);
            await storeOutreachDraft(sibling || { id: row.id, organization_id: orgId, metadata: { ...meta, company_research: research } }, research).catch(() => {});
        }
    }
    return reused;
}

export async function processCompanyResearchJob(job) {
    const { leadId, organizationId, force } = job.data || {};
    const orgId = Number(organizationId || 1);
    const lead = await Lead.findById(leadId, orgId);
    if (!lead) return { skipped: true, reason: "lead_missing" };
    if (lead.do_not_contact) return { skipped: true, reason: "dnc" };

    const meta = readMetadata(lead);
    if (meta.company_research_status !== "pending" || meta.outreach_status !== "writing") {
        await Lead.updateById(lead.id, {
            metadata: {
                ...meta,
                company_research_status: meta.company_research_status === "ready" ? meta.company_research_status : "pending",
                outreach_status: meta.outreach_email?.subject ? meta.outreach_status : "writing",
            },
        }, orgId).catch(() => {});
    }

    emitOrgEvent(orgId, "company_research_started", { jobId: job.id, leadId: Number(lead.id), status: "active" });
    await publishAseEvent("COMPANY_RESEARCH_REQUESTED", {
        organization_id: orgId,
        lead_id: lead.id,
        channel: "AI_RESEARCH",
        status: "PENDING",
    });

    const research = await researchLeadCompany(lead, { skipDraft: true, force: Boolean(force) });
    const usable = isUsableResearchProfile(research);
    if (!usable) {
        const latest = await Lead.findById(lead.id, orgId);
        const latestMeta = readMetadata(latest || lead);
        await Lead.updateById(lead.id, {
            metadata: {
                ...latestMeta,
                company_research: research || latestMeta.company_research || null,
                company_research_status: "failed",
                company_research_failed_at: new Date().toISOString(),
                outreach_status: latestMeta.outreach_email?.subject ? latestMeta.outreach_status : "writing",
            },
        }, orgId).catch(() => {});

        // Still try a conservative draft so the UI does not spin forever.
        const queued = await enqueueEmailPersonalizationJob(latest || lead, research);
        if (!queued) {
            await storeOutreachDraft(latest || lead, research).catch((err) => {
                console.warn(`[CompanyResearch] conservative draft failed for lead ${lead.id}: ${err.message}`);
            });
        }

        emitOrgEvent(orgId, "company_research_failed", { jobId: job.id, leadId: Number(lead.id), status: "failed" });
        return { ok: false, leadId: Number(lead.id), drafted: true };
    }

    const domain = cleanDomain(lead.email ? lead.email.split("@")[1] : null) || cleanDomain(research.domain);
    await setCachedResearch(domain, research, orgId);
    const reused = await reuseResearchForDomain(lead, research);

    const queued = await enqueueEmailPersonalizationJob(lead, research);
    if (!queued) {
        const latest = await Lead.findById(lead.id, orgId);
        await storeOutreachDraft(latest || lead, research);
    }

    emitOrgEvent(orgId, "company_research_completed", {
        jobId: job.id,
        leadId: Number(lead.id),
        status: "completed",
        company: research.company || null,
        reused,
    });
    await publishAseEvent("COMPANY_RESEARCH_COMPLETED", {
        organization_id: orgId,
        lead_id: lead.id,
        channel: "AI_RESEARCH",
        status: "COMPLETED",
        payload: { company: research.company, source: research.source, reused },
    });
    return { ok: true, leadId: Number(lead.id), reused };
}

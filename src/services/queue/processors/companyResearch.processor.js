import { Lead } from "../../../models/lead.model.js";
import { query } from "../../../config/db.js";
import { cleanDomain, isUsableResearchProfile } from "../../ase/companyResearch.service.js";
import { researchLeadCompany } from "../../leads/companyResearchQueue.js";
import { enqueueEmailPersonalizationJob } from "../enqueue.js";
import { emitOrgEvent, publishAseEvent } from "../realtime.js";
import { setCachedResearch } from "../cache.service.js";

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
            metadata: { ...meta, company_research: research, company_research_status: "ready" },
        }, orgId);
        reused += 1;
        await enqueueEmailPersonalizationJob({ id: row.id, organization_id: orgId, user_id: lead.user_id || null }, research);
    }
    return reused;
}

export async function processCompanyResearchJob(job) {
    const { leadId, organizationId } = job.data || {};
    const orgId = Number(organizationId || 1);
    const lead = await Lead.findById(leadId, orgId);
    if (!lead) return { skipped: true, reason: "lead_missing" };
    if (lead.do_not_contact) return { skipped: true, reason: "dnc" };

    emitOrgEvent(orgId, "company_research_started", { jobId: job.id, leadId: Number(lead.id), status: "active" });
    await publishAseEvent("COMPANY_RESEARCH_REQUESTED", {
        organization_id: orgId,
        lead_id: lead.id,
        channel: "AI_RESEARCH",
        status: "PENDING",
    });

    const research = await researchLeadCompany(lead, { skipDraft: true });
    const usable = isUsableResearchProfile(research);
    if (!usable) {
        emitOrgEvent(orgId, "company_research_failed", { jobId: job.id, leadId: Number(lead.id), status: "failed" });
        return { ok: false, leadId: Number(lead.id) };
    }

    const domain = cleanDomain(lead.email ? lead.email.split("@")[1] : research.domain);
    await setCachedResearch(domain, research);
    const reused = await reuseResearchForDomain(lead, research);
    await enqueueEmailPersonalizationJob(lead, research);

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

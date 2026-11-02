import { CompanyProfile } from "../models/companyProfile.model.js";
import { isGroundedResearch, researchCompany } from "../services/research.service.js";
import { buildOutreachSignals } from "../services/signals.service.js";
import { enqueueCompanyResearchJob } from "../../../services/queue/enqueue.js";
import { researchLeadCompany } from "../../../services/leads/companyResearchQueue.js";

function orgOf(req) {
    return Number(req.user?.organization_id || 0);
}

export function presentProfile(research) {
    if (!research) return null;
    const { unverifiedHypothesis, rejectedFacts, ...rest } = research;
    return {
        ...rest,
        grounded: isGroundedResearch(research),
        signals: buildOutreachSignals(research),
        unverified: unverifiedHypothesis ? { ...unverifiedHypothesis, note: "Not from any source. Do not use in outreach." } : null,
        rejectedFactCount: Array.isArray(rejectedFacts) ? rejectedFacts.length : 0,
    };
}

export async function getLeadIntelligence(req, res) {
    const profile = await CompanyProfile.findByLead(req.params.leadId, orgOf(req));
    if (!profile) return res.status(404).json({ error: { code: "LEAD_NOT_FOUND", message: "Lead not found" } });
    return res.json({
        data: {
            leadId: Number(profile.lead.id),
            company: profile.lead.company || null,
            status: profile.status,
            failedAt: profile.failedAt,
            profile: presentProfile(profile.research),
        },
    });
}

export async function refreshLeadIntelligence(req, res) {
    const profile = await CompanyProfile.findByLead(req.params.leadId, orgOf(req));
    if (!profile) return res.status(404).json({ error: { code: "LEAD_NOT_FOUND", message: "Lead not found" } });
    if (profile.lead.do_not_contact) return res.status(409).json({ error: { code: "DO_NOT_CONTACT", message: "Lead is marked do-not-contact" } });
    const queued = await enqueueCompanyResearchJob(profile.lead, { force: true });
    if (queued) return res.status(202).json({ data: { leadId: Number(profile.lead.id), status: "queued", jobId: queued.id } });
    const research = await researchLeadCompany(profile.lead, { skipDraft: true, force: true });
    return res.json({ data: { leadId: Number(profile.lead.id), status: research ? "completed" : "failed", profile: presentProfile(research) } });
}

export async function previewIntelligence(req, res) {
    const company = String(req.body?.company || "").trim().slice(0, 120);
    const domain = String(req.body?.domain || "").trim().slice(0, 253);
    if (!company && !domain) return res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "company or domain is required" } });
    const research = await researchCompany(company || domain.split(".")[0], {
        domain: domain || null,
        organizationId: orgOf(req),
        leadInfo: { organization_id: orgOf(req) },
        force: Boolean(req.body?.force),
    });
    return res.json({ data: { profile: presentProfile(research) } });
}

import { researchCompany } from "../ase/companyResearch.service.js";
import { storeOutreachDraft } from "../ase/leadEmailDrafter.service.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";

const LIMIT = 3;
const pending = [];
let active = 0;

function readMetadata(lead) {
    if (!lead?.metadata) return {};
    if (typeof lead.metadata === "string") {
        try {
            return JSON.parse(lead.metadata);
        } catch {
            return {};
        }
    }
    return lead.metadata;
}

async function kickScheduler() {
    const { aseScheduler } = await import("../ase/scheduler.service.js");
    aseScheduler.kick();
}

export async function researchLeadCompany(lead) {
    if (!lead?.id) return null;
    const orgId = Number(lead.organization_id || 1);
    const fresh = await Lead.findById(lead.id, orgId);
    if (!fresh || fresh.do_not_contact) return null;

    const existing = readMetadata(fresh);
    if (existing.company_research?.summary || existing.company_research?.qualityStatus) {
        if (!existing.outreach_email?.subject) {
            await storeOutreachDraft(fresh, existing.company_research);
        } else if (existing.company_research_status === "pending") {
            await Lead.updateById(
                fresh.id,
                { metadata: { ...existing, company_research_status: "ready" } },
                orgId
            );
        }
        await kickScheduler();
        return existing.company_research;
    }

    const domain = fresh.email ? fresh.email.split("@")[1] : null;
    let research = null;
    try {
        research = await researchCompany(fresh.company, { domain, leadInfo: fresh });
    } catch (error) {
        console.error("[CompanyResearch] Research failed:", error.message);
    }

    const latest = await Lead.findById(fresh.id, orgId);
    const latestMeta = readMetadata(latest || fresh);
    const metadata = {
        ...latestMeta,
        company_research: research || latestMeta.company_research || null,
        company_research_status: (research?.summary || research?.qualityStatus) ? "ready" : "failed",
    };

    const researched = await Lead.updateById(fresh.id, { metadata }, orgId);
    if (research?.summary || research?.qualityStatus || latestMeta.company_research?.summary || latestMeta.company_research?.qualityStatus) {
        await storeOutreachDraft(researched || { ...fresh, metadata }, research || latestMeta.company_research);
    }

    if (research?.summary || research?.qualityStatus) {
        await LeadEvent.create({
            organization_id: orgId,
            lead_id: fresh.id,
            user_id: fresh.user_id || lead.user_id || null,
            channel: "AI_RESEARCH",
            event_type: "COMPANY_RESEARCHED",
            status: "COMPLETED",
            payload: {
                company: research.company,
                summary: research.summary,
                coreServices: research.coreServices,
                industry: research.industry,
                targetAudience: research.targetAudience,
                growthOpportunity: research.growthOpportunity,
                source: research.source,
            },
        });
    }

    await kickScheduler();
    return research;
}

function drain() {
    while (active < LIMIT && pending.length > 0) {
        const lead = pending.shift();
        active += 1;
        researchLeadCompany(lead)
            .catch((error) => {
                console.error("[CompanyResearch] Queue job failed:", error.message);
            })
            .finally(() => {
                active -= 1;
                drain();
            });
    }
}

export function enqueueLeadCompanyResearch(lead) {
    if (process.env.ASE_SKIP_OUTREACH === "1") return;
    if (!lead?.id) return;
    pending.push(lead);
    drain();
}

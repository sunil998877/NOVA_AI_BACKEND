import { Lead } from "../../../models/lead.model.js";

function readMetadata(lead) {
    if (!lead?.metadata) return {};
    if (typeof lead.metadata === "object") return lead.metadata;
    try {
        return JSON.parse(lead.metadata);
    } catch {
        return {};
    }
}

export const CompanyProfile = {
    async findByLead(leadId, orgId) {
        const lead = await Lead.findById(Number(leadId), Number(orgId));
        if (!lead) return null;
        const meta = readMetadata(lead);
        return {
            lead,
            research: meta.company_research || null,
            status: meta.company_research_status || (meta.company_research ? "ready" : "not_started"),
            failedAt: meta.company_research_failed_at || null,
        };
    },
};

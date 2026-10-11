import { asyncHandler } from "../../utils/asyncHandler.js";
import { processBatch, processLead, LEAD_SOURCES } from "../../services/leads/leadIntake.service.js";

export const ingestLeadsFromApi = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const list = Array.isArray(body)
        ? body
        : Array.isArray(body?.leads)
        ? body.leads
        : Array.isArray(body?.data)
        ? body.data
        : null;

    const options = {
        organizationId: Number(req.user?.organization_id || req.headers["x-organization-id"] || 1),
        userId: req.user?.id || null,
        source: body.source || (req.authVia === "lead_api_key" ? LEAD_SOURCES.API : "MANUAL"),
        updateExisting: req.query.update === "true" || Boolean(body.updateExisting),
        matchDomain: req.query.matchDomain === "true" || Boolean(body.matchDomain),
    };

    if (list) {
        if (list.length === 0) return res.status(400).json({ error: "No leads provided" });
        const summary = await processBatch(list, options);
        return res.status(200).json({ data: summary });
    }

    const singlePayload = body.lead || (body.data && typeof body.data === "object" ? body.data : body);

    try {
        const result = await processLead(singlePayload, options);
        return res.status(result.status === "created" ? 201 : 200).json({ data: result });
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

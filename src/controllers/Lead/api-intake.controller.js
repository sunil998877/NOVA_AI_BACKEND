import { asyncHandler } from "../../utils/asyncHandler.js";
import { processBatch, processLead, LEAD_SOURCES, MAX_BATCH } from "../../services/leads/leadIntake.service.js";

const unwrapBody = (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return body || {};
    const wrapped = body.payload || body.form_response || body.lead_data;
    if (
        wrapped &&
        typeof wrapped === "object" &&
        !Array.isArray(wrapped) &&
        !body.email &&
        !Array.isArray(body.leads) &&
        !Array.isArray(body.data)
    ) {
        return {
            ...wrapped,
            source: wrapped.source || body.source,
            updateExisting: wrapped.updateExisting ?? body.updateExisting,
        };
    }
    return body;
};

export const ingestLeadsFromApi = asyncHandler(async (req, res) => {
    const body = unwrapBody(req.body || {});
    const list = Array.isArray(body)
        ? body
        : Array.isArray(body?.leads)
        ? body.leads
        : Array.isArray(body?.data)
        ? body.data
        : null;

    const organizationId = Number(req.user?.organization_id);
    if (!organizationId) {
        return res.status(401).json({ error: "Authenticated organization is required" });
    }

    const options = {
        organizationId,
        userId: req.user?.id || null,
        source: body.source || (req.authVia === "lead_api_key" ? LEAD_SOURCES.API : "MANUAL"),
        updateExisting: req.query.update === "true" || Boolean(body.updateExisting),
        matchDomain:
            String(body.source || "").toUpperCase() === "MANUAL"
                ? false
                : req.query.matchDomain !== "false" && body.matchDomain !== false,
    };

    if (list) {
        if (list.length === 0) {
            return res.status(400).json({ error: "No leads provided", maxBatch: MAX_BATCH });
        }
        if (list.length > MAX_BATCH) {
            return res.status(413).json({
                error: `Batch exceeds maximum of ${MAX_BATCH} leads`,
                maxBatch: MAX_BATCH,
                received: list.length,
            });
        }
        try {
            const summary = await processBatch(list, options);
            const succeeded = summary.created + summary.updated + summary.skipped;
            const status = summary.failed > 0 && succeeded === 0 ? 400 : summary.failed > 0 ? 207 : 200;
            return res.status(status).json({ data: summary });
        } catch (error) {
            const status = error.statusCode || 400;
            return res.status(status).json({ error: error.message, maxBatch: MAX_BATCH });
        }
    }

    const singlePayload = body.lead || (body.data && typeof body.data === "object" ? body.data : body);

    try {
        const result = await processLead(singlePayload, options);
        return res.status(result.status === "created" ? 201 : 200).json({ data: result });
    } catch (error) {
        return res.status(error.statusCode || 400).json({
            error: error.message,
            field: error.field || null,
            code: error.code || null,
            details: error.details || null,
        });
    }
});

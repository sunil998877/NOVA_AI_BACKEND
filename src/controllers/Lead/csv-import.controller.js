import { asyncHandler } from "../../utils/asyncHandler.js";
import { csvToLeads } from "../../services/leads/csvParser.js";
import { processBatch, LEAD_SOURCES } from "../../services/leads/leadIntake.service.js";
import { enqueueLeadImportJob } from "../../services/queue/enqueue.js";
import { LeadImportJob } from "../../models/lead-import-job.model.js";

const MAX_CSV_BYTES = 5 * 1024 * 1024;

const readCsv = (req) => {
    const csv = req.body?.csv;
    if (!csv || typeof csv !== "string") {
        const err = new Error("Send the file contents as { csv: \"...\" }");
        err.status = 400;
        throw err;
    }
    if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) {
        const err = new Error("CSV is too large (max 5 MB)");
        err.status = 413;
        throw err;
    }
    return csv;
};

export const previewCsv = asyncHandler(async (req, res) => {
    try {
        const { headers, mapping, leads } = csvToLeads(readCsv(req), req.body.columnMap);
        return res.status(200).json({
            data: { headers, mapping, totalRows: leads.length, sample: leads.slice(0, 5) },
        });
    } catch (error) {
        return res.status(error.status || 400).json({ error: error.message });
    }
});

export const importCsv = asyncHandler(async (req, res) => {
    let parsed;
    try {
        parsed = csvToLeads(readCsv(req), req.body.columnMap);
    } catch (error) {
        return res.status(error.status || 400).json({ error: error.message });
    }

    if (parsed.mapping?.email === undefined) {
        return res.status(400).json({
            error: "Could not find an email column. Map one of the CSV headers to 'email'.",
            headers: parsed.headers,
        });
    }
    if (parsed.leads.length === 0) {
        return res.status(400).json({ error: "The CSV has no data rows" });
    }

    const organizationId = Number(req.user.organization_id || 1);
    const queued = await enqueueLeadImportJob({
        organizationId,
        userId: req.user.id,
        source: LEAD_SOURCES.CSV,
        updateExisting: Boolean(req.body.updateExisting),
        leads: parsed.leads,
    });
    if (queued?.queued) {
        return res.status(202).json({ data: queued });
    }

    const summary = await processBatch(parsed.leads, {
        organizationId,
        userId: req.user.id,
        source: LEAD_SOURCES.CSV,
        updateExisting: Boolean(req.body.updateExisting),
        matchDomain: false,
    });
    return res.status(200).json({ data: summary });
});

export const getImportJob = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const job = await LeadImportJob.findById(req.params.id, orgId);
    if (!job) return res.status(404).json({ error: "Import job not found" });
    return res.status(200).json({ data: job });
});

export const listImportJobs = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const jobs = await LeadImportJob.listRecent(orgId, Number(req.query.limit || 20));
    return res.status(200).json({ data: jobs });
});

import { asyncHandler } from "../../utils/asyncHandler.js";
import { buildOrgReport, listLiveSegments, loadComplianceLog } from "../../services/ase/reportsQuery.service.js";
import { complianceToCsv, reportToCsv } from "../../services/ase/reports.service.js";

export const getAseReports = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const data = await buildOrgReport(orgId);
    return res.status(200).json({ data });
});

export const exportAseReportsCsv = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const data = await buildOrgReport(orgId);
    const csv = reportToCsv(data);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="ase-report-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.status(200).send(csv);
});

export const getComplianceLog = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const rows = await loadComplianceLog(orgId, req.query.limit);
    if (String(req.query.format || "").toLowerCase() === "csv") {
        const csv = complianceToCsv(rows);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="ase-compliance-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.status(200).send(csv);
    }
    return res.status(200).json({ data: rows });
});

export const listSegments = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const data = await listLiveSegments(orgId);
    return res.status(200).json({ data });
});

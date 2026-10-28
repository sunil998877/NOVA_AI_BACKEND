import { Lead } from "../../models/lead.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { aseDecisionEngine } from "../../services/ase/brain/aseDecisionEngine.service.js";
import { modelEvaluationService } from "../../services/ase/brain/modelEvaluation.service.js";
import { getOperatingMode } from "../../services/ase/operatingMode.service.js";
import { getLeadApproval } from "../../services/ase/approvalQueue.service.js";
import { buildNbaCard } from "../../services/ase/nbaCard.service.js";
export { getOperatingModeStatus, updateOperatingMode } from "../Ase/operating-mode.controller.js";

export const getLeadDecision = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const lead = await Lead.findById(req.params.id, orgId);

    if (!lead) {
        return res.status(404).json({ error: "Lead not found in your organization" });
    }

    const decision = await aseDecisionEngine.evaluateLead(lead, { audit: false });
    const [operatingMode, pendingApproval] = await Promise.all([
        getOperatingMode(orgId).catch(() => "FULLY_AUTOMATED"),
        getLeadApproval(orgId, lead.id).catch(() => null),
    ]);
    const nba = await buildNbaCard(lead, decision, { operatingMode, pendingApproval }).catch(() => null);
    return res.status(200).json({
        success: true,
        leadId: lead.id,
        decision,
        nba,
    });
});

export const getLeadConversionPrediction = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const lead = await Lead.findById(req.params.id, orgId);

    if (!lead) {
        return res.status(404).json({ error: "Lead not found in your organization" });
    }

    const decision = await aseDecisionEngine.evaluateLead(lead, { audit: false });
    return res.status(200).json({
        success: true,
        leadId: lead.id,
        conversionPrediction: decision.conversionPrediction,
    });
});

export const getBrainStatus = asyncHandler(async (req, res) => {
    const status = aseDecisionEngine.getStatus();
    return res.status(200).json({
        success: true,
        status,
    });
});

export const updateBrainMode = asyncHandler(async (req, res) => {
    const { mode } = req.body;
    if (!mode) {
        return res.status(400).json({ error: "Mode parameter is required" });
    }

    try {
        const result = aseDecisionEngine.setMode(mode);
        return res.status(200).json({
            success: true,
            ...result,
        });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
});

export const getBrainEvaluation = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const report = await modelEvaluationService.getEvaluationReport(orgId);
    return res.status(200).json({
        success: true,
        report,
    });
});

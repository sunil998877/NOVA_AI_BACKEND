import { asyncHandler } from "../../utils/asyncHandler.js";
import { aseScheduler } from "../../services/ase/scheduler.service.js";
import {
    getLeadApproval,
    holdLeadApproval,
    listApprovals,
    prepareLeadApproval,
    reviewApprovalById,
    unholdLeadApproval,
} from "../../services/ase/approvalQueue.service.js";
import { AseApproval } from "../../models/ase-approval.model.js";
import { APPROVAL_STATUSES } from "../../schema/ase-approval.schema.js";

function httpError(err, res) {
    return res.status(err.status || 500).json({ error: err.message });
}

export const listOrgApprovals = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const items = await listApprovals(orgId, {
        status: req.query.status || APPROVAL_STATUSES.PENDING,
        leadId: req.query.lead_id ? Number(req.query.lead_id) : null,
        limit: req.query.limit,
    });
    return res.status(200).json({ success: true, data: items });
});

export const getLeadPendingApproval = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const approval = await getLeadApproval(orgId, req.params.leadId);
    return res.status(200).json({ success: true, data: approval });
});

export const approveLeadAction = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const userId = req.user?.id || null;
    try {
        const prepared = await prepareLeadApproval(orgId, req.params.leadId, userId, {
            actionType: req.body?.action,
        });
        const result = await aseScheduler.processLeadAction(prepared.lead, {
            approved: true,
            force: true,
        });
        if (!result?.executed) {
            return res.status(400).json({
                error: result?.reason || "Approved action did not execute",
                data: { approval: prepared.approval, executed: false },
            });
        }
        return res.status(200).json({
            success: true,
            data: {
                approval: prepared.approval,
                executed: true,
                action: result.action,
            },
        });
    } catch (err) {
        return httpError(err, res);
    }
});

export const holdLeadAction = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const userId = req.user?.id || null;
    try {
        const result = await holdLeadApproval(orgId, req.params.leadId, userId);
        return res.status(200).json({ success: true, data: result });
    } catch (err) {
        return httpError(err, res);
    }
});

export const unholdLeadAction = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const userId = req.user?.id || null;
    try {
        const result = await unholdLeadApproval(orgId, req.params.leadId, userId);
        return res.status(200).json({ success: true, data: result });
    } catch (err) {
        return httpError(err, res);
    }
});

export const approveById = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const userId = req.user?.id || null;
    try {
        const existing = await AseApproval.findById(orgId, req.params.id);
        if (!existing) {
            return res.status(404).json({ error: "Approval not found" });
        }
        const prepared = await prepareLeadApproval(orgId, existing.lead_id, userId, {
            actionType: existing.action_type,
        });
        const result = await aseScheduler.processLeadAction(prepared.lead, {
            approved: true,
            force: true,
        });
        return res.status(200).json({
            success: true,
            data: { approval: prepared.approval, executed: Boolean(result?.executed), action: result?.action },
        });
    } catch (err) {
        return httpError(err, res);
    }
});

export const holdById = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const userId = req.user?.id || null;
    try {
        const approval = await reviewApprovalById(orgId, req.params.id, userId, APPROVAL_STATUSES.HELD);
        return res.status(200).json({ success: true, data: approval });
    } catch (err) {
        return httpError(err, res);
    }
});

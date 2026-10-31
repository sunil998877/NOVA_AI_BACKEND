import { asyncHandler } from "../../utils/asyncHandler.js";
import { CadencePolicy } from "../../models/ase-cadence.model.js";
import {
    approveEmailStep,
    checkEligibility,
    enrollLead,
    executeStep,
    getLeadCadence,
    listQueue,
    pauseCadence,
    rejectEmailStep,
    resolvePolicy,
    resolveReviewStep,
    resumeCadence,
    savePolicy,
    stopCadence,
} from "../../services/ase/cadence/cadence.service.js";

const orgOf = (req) => Number(req.user?.organization_id || 1);
const userOf = (req) => (req.user?.id ? Number(req.user.id) : null);

function sendError(err, res) {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error("[Cadence API]", err.message);
    return res.status(status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
}

const handle = (fn) => asyncHandler(async (req, res) => {
    try {
        const data = await fn(req, res);
        if (!res.headersSent) res.status(200).json({ success: true, data });
    } catch (err) {
        sendError(err, res);
    }
});

export const listPolicies = handle(async (req) => {
    const orgId = orgOf(req);
    await resolvePolicy(orgId);
    return CadencePolicy.list(orgId);
});

export const getDefaultPolicy = handle(async (req) => resolvePolicy(orgOf(req)));

export const createPolicy = handle(async (req) => savePolicy(orgOf(req), {
    name: req.body?.name,
    settings: req.body?.settings,
    isDefault: Boolean(req.body?.isDefault),
}, userOf(req)));

export const updatePolicy = handle(async (req) => savePolicy(orgOf(req), {
    id: Number(req.params.policyId),
    name: req.body?.name,
    settings: req.body?.settings,
    isDefault: Boolean(req.body?.isDefault),
    isActive: req.body?.isActive,
    expectedVersion: req.body?.version ?? null,
}, userOf(req)));

export const getLeadCadenceState = handle(async (req) => getLeadCadence(orgOf(req), Number(req.params.leadId)));

export const getLeadEligibility = handle(async (req) => {
    const { eligibility, timezone, policy, settings } = await checkEligibility(orgOf(req), Number(req.params.leadId), {
        policyId: req.query.policyId ? Number(req.query.policyId) : null,
    });
    return {
        eligibility,
        timezone,
        policy: { id: policy.id, name: policy.name, version: policy.version },
        preview: {
            firstAction: settings.firstAction,
            maxInitialCallAttempts: settings.maxInitialCallAttempts,
            retryIntervalMinutes: settings.retryIntervalMinutes,
            busyRetryIntervalMinutes: settings.busyRetryIntervalMinutes,
            emailAfterRetryDelayMinutes: settings.emailAfterRetryDelayMinutes,
            emailApprovalMode: settings.emailApprovalMode,
            voicemailAction: settings.voicemailAction,
            callingWindow: settings.callingWindow,
            followUpSteps: settings.followUpSteps,
        },
    };
});

export const enrollLeadInCadence = handle(async (req, res) => {
    const orgId = orgOf(req);
    const result = await enrollLead(orgId, Number(req.params.leadId), {
        policyId: req.body?.policyId ? Number(req.body.policyId) : null,
        actorId: userOf(req),
        startNow: req.body?.startNow !== false,
        confirmReview: Boolean(req.body?.confirmReview),
    });
    if (!result.enrolled) {
        const status = result.requiresConfirmation ? 409 : 200;
        res.status(status).json({ success: false, data: result });
        return null;
    }
    const first = result.steps?.[0];
    if (first && new Date(first.due_at).getTime() <= Date.now() + 1000) {
        setImmediate(() => {
            executeStep(orgId, first.id, { source: "api" }).catch((err) => console.error("[Cadence API] first step failed:", err.message));
        });
    }
    return result;
});

export const pauseLeadCadence = handle(async (req) => pauseCadence(orgOf(req), Number(req.params.leadId), userOf(req), req.body?.reason || "Paused by user"));
export const resumeLeadCadence = handle(async (req) => resumeCadence(orgOf(req), Number(req.params.leadId), userOf(req), req.body?.reason || "Resumed by user"));
export const stopLeadCadence = handle(async (req) => stopCadence(orgOf(req), Number(req.params.leadId), userOf(req), req.body?.reason || "Stopped by user"));

export const approveStep = handle(async (req) => approveEmailStep(orgOf(req), Number(req.params.stepId), userOf(req), {
    ...(req.body?.subject !== undefined ? { subject: req.body.subject } : {}),
    ...(req.body?.text !== undefined ? { text: req.body.text } : {}),
}));

export const rejectStep = handle(async (req) => rejectEmailStep(orgOf(req), Number(req.params.stepId), userOf(req), req.body?.reason || "Rejected by reviewer"));

export const resolveReview = handle(async (req) => resolveReviewStep(orgOf(req), Number(req.params.stepId), userOf(req), {
    decision: req.body?.decision || "CONTINUE",
    note: req.body?.note || "",
}));

export const getCadenceQueue = handle(async (req) => listQueue(orgOf(req), {
    filter: req.query.filter || null,
    leadId: req.query.leadId ? Number(req.query.leadId) : null,
    limit: req.query.limit,
    offset: req.query.offset,
}));

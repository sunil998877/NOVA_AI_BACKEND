import { asyncHandler } from "../../utils/asyncHandler.js";
import {
    approveReplyDraft,
    editReplyDraft,
    getReplyDraft,
    listReplyDrafts,
    rejectReplyDraft,
    sendReplyDraft,
} from "../../services/ase/replyApproval.service.js";
const orgOf = (req) => Number(req.user?.organization_id || 1);
const reviewer = (req) => ({ ...req.user, authVia: req.authVia });

function sendError(err, res) {
    const status = err.status || 500;
    return res.status(status).json({
        error: status >= 500 ? "Reply draft operation failed" : err.message,
        code: err.code || undefined,
        issues: err.issues || undefined,
    });
}

const handle = (fn) => asyncHandler(async (req, res) => {
    try {
        return res.status(200).json({ success: true, data: await fn(req) });
    } catch (err) {
        if (!err.status) console.error("[ReplyDraft]", err.message);
        return sendError(err, res);
    }
});

export const listDrafts = handle(async (req) => {
    const listed = await listReplyDrafts(orgOf(req), {
        status: req.query.status || null,
        leadId: req.query.lead_id || null,
        limit: req.query.limit,
        offset: req.query.offset,
    });
    return { items: listed.drafts || [], counts: listed.counts || {} };
});

export const getDraft = handle((req) => getReplyDraft(orgOf(req), req.params.id));

export const editDraft = handle((req) =>
    editReplyDraft(orgOf(req), req.params.id, reviewer(req), {
        subject: req.body?.subject,
        bodyText: req.body?.bodyText ?? req.body?.body_text,
    })
);

export const approveDraft = handle((req) =>
    approveReplyDraft(orgOf(req), req.params.id, reviewer(req), {
        acknowledgeIssues: req.body?.acknowledgeIssues === true,
    })
);

export const rejectDraft = handle((req) =>
    rejectReplyDraft(orgOf(req), req.params.id, reviewer(req), { reason: req.body?.reason || "" })
);

export const sendDraft = handle((req) =>
    sendReplyDraft(orgOf(req), req.params.id, reviewer(req), { confirmResend: req.body?.confirmResend === true })
);

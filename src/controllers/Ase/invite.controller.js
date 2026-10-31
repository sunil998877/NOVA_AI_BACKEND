import { asyncHandler } from "../../utils/asyncHandler.js";
import { Organization } from "../../models/organization.model.js";
import { OrgInvite } from "../../models/org-invite.model.js";
import { createOrgInvite } from "../../services/ase/orgBinding.service.js";
import { publicApiBase } from "../../services/leads/leadApiCredential.service.js";

export const previewInvite = asyncHandler(async (req, res) => {
    const invite = await OrgInvite.findValidByToken(req.params.token);
    if (!invite) return res.status(404).json({ error: "Invite is invalid or expired" });
    const org = await Organization.findById(invite.organization_id);
    return res.status(200).json({
        data: {
            email: invite.email,
            role: invite.role,
            organization: org?.name || "",
            organization_id: invite.organization_id,
        },
    });
});

export const createInvite = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id);
    let invite;
    try {
        invite = await createOrgInvite({
            orgId,
            email: req.body.email,
            role: req.body.role,
            invitedBy: req.user.id,
        });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message || "Could not create invite" });
    }
    const origin = String(req.headers["x-frontend-url"] || publicApiBase(req) || "").replace(/\/api\/?$/, "");
    const signupPath = `/signup?invite=${encodeURIComponent(invite.token)}`;
    return res.status(201).json({
        data: {
            id: invite.id,
            email: invite.email,
            role: invite.role,
            expires_at: invite.expires_at,
            token: invite.token,
            inviteUrl: `${origin}${signupPath}`,
        },
    });
});

export const listInvites = asyncHandler(async (req, res) => {
    const rows = await OrgInvite.listByOrg(req.user.organization_id);
    return res.status(200).json({
        data: rows.map((row) => ({
            id: row.id,
            email: row.email,
            role: row.role,
            expires_at: row.expires_at,
            accepted_at: row.accepted_at,
            created_at: row.created_at,
        })),
    });
});

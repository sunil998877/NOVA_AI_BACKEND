import { Organization } from "../../models/organization.model.js";
import { OrgInvite } from "../../models/org-invite.model.js";
import { User } from "../../models/user.model.js";
import { ROLES, normalizeInviteRole, roleForNewRegistration } from "./roles.constants.js";

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

export async function bindSignupAccount({
    fullName,
    organization,
    email,
    passwordHash = null,
    googleId = null,
    authProvider = "local",
    inviteToken = "",
} = {}) {
    const cleanedEmail = String(email || "").toLowerCase().trim();
    if (!cleanedEmail) throw httpError(400, "Email is required");

    let org;
    let role = ROLES.ORG_ADMIN;
    let invite = null;

    const token = String(inviteToken || "").trim();
    if (token) {
        invite = await OrgInvite.findValidByToken(token);
        if (!invite) throw httpError(400, "Invite is invalid or expired");
        if (String(invite.email || "").toLowerCase() !== cleanedEmail) {
            throw httpError(400, "Invite email does not match");
        }
        org = await Organization.findById(invite.organization_id);
        if (!org) throw httpError(400, "Invite organization no longer exists");
        role = roleForNewRegistration(invite);
    } else {
        const orgName = String(organization || "").trim();
        if (!orgName) throw httpError(400, "Organization is required");
        org = await Organization.create({ name: orgName });
        role = roleForNewRegistration(null);
    }

    const user = await User.create({
        fullName: String(fullName || cleanedEmail.split("@")[0]).trim(),
        organization: org.name,
        email: cleanedEmail,
        passwordHash,
        googleId,
        authProvider,
        organization_id: org.id,
        role,
    });

    if (!user?.organization_id || !user?.role) {
        throw httpError(500, "Failed to bind user to organization");
    }

    if (invite) {
        await OrgInvite.markAccepted(invite.id);
    }

    return { user, organization: org, role };
}

export async function createOrgInvite({ orgId, email, role, invitedBy }) {
    const cleanedEmail = String(email || "").toLowerCase().trim();
    if (!cleanedEmail) throw httpError(400, "Email is required");
    const invitedRole = normalizeInviteRole(role);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    return OrgInvite.create({
        organization_id: orgId,
        email: cleanedEmail,
        role: invitedRole,
        invited_by: invitedBy,
        expiresAt,
    });
}

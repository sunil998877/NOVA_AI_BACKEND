export const ROLES = Object.freeze({
    SUPER_ADMIN: "SUPER_ADMIN",
    ORG_ADMIN: "ORG_ADMIN",
    SALES_MANAGER: "SALES_MANAGER",
    SALESPERSON: "SALESPERSON",
    CAMPAIGN_OPERATOR: "CAMPAIGN_OPERATOR",
    SYSTEM_AGENT: "SYSTEM_AGENT",
});

export const ASE_ROLES = Object.freeze([
    ROLES.SUPER_ADMIN,
    ROLES.ORG_ADMIN,
    ROLES.SALES_MANAGER,
    ROLES.SALESPERSON,
    ROLES.CAMPAIGN_OPERATOR,
    ROLES.SYSTEM_AGENT,
]);

export const ASE_ADMIN_ROLES = Object.freeze([
    ROLES.SUPER_ADMIN,
    ROLES.ORG_ADMIN,
    ROLES.SALES_MANAGER,
    ROLES.CAMPAIGN_OPERATOR,
]);

export const INVITEABLE_ROLES = Object.freeze([
    ROLES.SALESPERSON,
    ROLES.SALES_MANAGER,
    ROLES.CAMPAIGN_OPERATOR,
    ROLES.ORG_ADMIN,
]);

export const ADMIN_PATHS = Object.freeze([
    "/ase/settings",
    "/ase/playbook",
    "/ase/compliance",
]);

export function normalizeRole(role, fallback = ROLES.SALESPERSON) {
    const value = String(role || "").toUpperCase().trim();
    return Object.values(ROLES).includes(value) ? value : fallback;
}

export function normalizeInviteRole(role) {
    const value = String(role || "").toUpperCase().trim();
    return INVITEABLE_ROLES.includes(value) ? value : ROLES.SALESPERSON;
}

export function roleAllowed(userRole, allowedRoles = []) {
    const role = normalizeRole(userRole, "");
    if (!role) return false;
    if (role === ROLES.SUPER_ADMIN) return true;
    return allowedRoles.includes(role);
}

export function canUseAse(role) {
    return roleAllowed(role, ASE_ROLES);
}

export function canOpenAdmin(role) {
    return roleAllowed(role, ASE_ADMIN_ROLES);
}

export function salespersonBlockedFromAdmin(role) {
    return normalizeRole(role) === ROLES.SALESPERSON && !canOpenAdmin(role);
}

export function roleForNewRegistration(invite = null) {
    if (invite?.role) return normalizeInviteRole(invite.role);
    return ROLES.ORG_ADMIN;
}

export function slugifyOrgName(name) {
    const base = String(name || "org")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
    return base || "org";
}

export function leadBelongsToOrg(lead, orgId) {
    if (!lead) return false;
    return Number(lead.organization_id || lead.organizationId) === Number(orgId);
}

export function scopedOrgId(user) {
    const id = Number(user?.organization_id || user?.organizationId);
    if (!Number.isFinite(id) || id < 1) return null;
    return id;
}

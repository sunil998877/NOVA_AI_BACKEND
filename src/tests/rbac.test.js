import { test } from "node:test";
import assert from "node:assert/strict";
import { requireAseAdmin, requireAseRole, requireRole } from "../middleware/auth.middleware.js";
import {
    ROLES,
    canOpenAdmin,
    canUseAse,
    leadBelongsToOrg,
    roleForNewRegistration,
    salespersonBlockedFromAdmin,
    slugifyOrgName,
} from "../services/ase/roles.constants.js";

function runMiddleware(stack, req) {
    let status = 200;
    let body = null;
    let nextCount = 0;
    const res = {
        status(code) {
            status = code;
            return this;
        },
        json(payload) {
            body = payload;
            return this;
        },
    };
    stack(req, res, () => {
        nextCount += 1;
    });
    return { status, body, nextCount };
}

test("register without invite is ORG_ADMIN; invite uses invited role", () => {
    assert.equal(roleForNewRegistration(null), ROLES.ORG_ADMIN);
    assert.equal(roleForNewRegistration({ role: "SALESPERSON" }), ROLES.SALESPERSON);
    assert.equal(roleForNewRegistration({ role: "SUPER_ADMIN" }), ROLES.SALESPERSON);
    assert.ok(slugifyOrgName("Evoke AI").startsWith("evoke-ai"));
});

test("salesperson cannot open Settings / Admin; ASE console is allowed", () => {
    assert.equal(canUseAse(ROLES.SALESPERSON), true);
    assert.equal(canOpenAdmin(ROLES.SALESPERSON), false);
    assert.equal(salespersonBlockedFromAdmin(ROLES.SALESPERSON), true);
    assert.equal(canOpenAdmin(ROLES.SALES_MANAGER), true);
    assert.equal(canOpenAdmin(ROLES.ORG_ADMIN), true);
});

test("requireAseAdmin forbids salesperson and requireAseRole allows them", () => {
    const sales = { user: { role: ROLES.SALESPERSON, organization_id: 9 } };
    const manager = { user: { role: ROLES.SALES_MANAGER, organization_id: 9 } };
    const blocked = runMiddleware(requireAseAdmin, sales);
    const allowedConsole = runMiddleware(requireAseRole, sales);
    const allowedAdmin = runMiddleware(requireAseAdmin, manager);
    assert.equal(blocked.status, 403);
    assert.equal(allowedConsole.status, 200);
    assert.equal(allowedConsole.nextCount, 1);
    assert.equal(allowedAdmin.status, 200);
});

test("user cannot load another org's lead", () => {
    const lead = { id: 12, organization_id: 2 };
    assert.equal(leadBelongsToOrg(lead, 2), true);
    assert.equal(leadBelongsToOrg(lead, 99), false);
    assert.equal(leadBelongsToOrg(null, 2), false);
});

test("requireRole still lets SUPER_ADMIN through admin gates", () => {
    const result = runMiddleware(requireRole(ROLES.ORG_ADMIN), {
        user: { role: ROLES.SUPER_ADMIN, organization_id: 1 },
    });
    assert.equal(result.status, 200);
    assert.equal(result.nextCount, 1);
});

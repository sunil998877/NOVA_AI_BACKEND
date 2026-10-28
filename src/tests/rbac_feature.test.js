import { test } from "node:test";
import assert from "node:assert/strict";
import { requireAseAdmin } from "../middleware/auth.middleware.js";
import {
    ROLES,
    canOpenAdmin,
    leadBelongsToOrg,
    roleForNewRegistration,
    salespersonBlockedFromAdmin,
} from "../services/ase/roles.constants.js";

test("feature: register writes organization role ORG_ADMIN unless invited", () => {
    assert.equal(roleForNewRegistration(null), ROLES.ORG_ADMIN);
    assert.equal(roleForNewRegistration({ role: "SALESPERSON" }), ROLES.SALESPERSON);
});

test("feature: salesperson cannot open Settings / Admin", () => {
    assert.equal(salespersonBlockedFromAdmin(ROLES.SALESPERSON), true);
    assert.equal(canOpenAdmin(ROLES.SALESPERSON), false);
    const req = { user: { role: ROLES.SALESPERSON, organization_id: 4 } };
    let status = 200;
    const res = {
        status(code) {
            status = code;
            return this;
        },
        json() {
            return this;
        },
    };
    requireAseAdmin(req, res, () => {});
    assert.equal(status, 403);
});

test("feature: org isolation — other org lead is not visible", () => {
    assert.equal(leadBelongsToOrg({ organization_id: 1 }, 2), false);
    assert.equal(leadBelongsToOrg({ organization_id: 7 }, 7), true);
});

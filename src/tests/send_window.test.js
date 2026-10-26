import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOptimalSendWindow } from "../services/ase/callingHours.service.js";

test("each lead gets its own send window from status, location, and id", () => {
    const sarah = buildOptimalSendWindow(
        { id: 13, status: "INTERESTED", email: "sarah@apextech.io", city: "San Francisco", state: "CA" },
        { action: "EMAIL", delayHours: 0, status: "INTERESTED", engagementScore: 40, emailOpens: 1 }
    );
    const kabir = buildOptimalSendWindow(
        { id: 11, status: "CONTACTED", email: "kabir@example.com", city: "Pune", state: "Maharashtra" },
        { action: "WAIT", delayHours: 4, status: "CONTACTED", engagementScore: 10, emailOpens: 0 }
    );
    const callLead = buildOptimalSendWindow(
        { id: 7, status: "ENGAGED", email: "reyansh@example.com", city: "Mumbai" },
        { action: "CALL", delayHours: 1, status: "ENGAGED", engagementScore: 70, emailOpens: 3 }
    );

    assert.equal(sarah.timezone, "America/Los_Angeles");
    assert.equal(kabir.timezone, "Asia/Kolkata");
    assert.notEqual(sarah.start, kabir.start);
    assert.notEqual(sarah.localHour, callLead.localHour);
    assert.ok(sarah.localHour >= 9 && sarah.localHour < 20);
    assert.ok(new Date(sarah.end) > new Date(sarah.start));
});

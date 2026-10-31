import { test } from "node:test";
import assert from "node:assert/strict";
import { startAutonomousCall } from "../services/ase/autonomousCall.service.js";
import { plivoVoiceAdapter } from "../services/ase/adapters/plivoVoice.adapter.js";

test("autonomous start uses the scheduler, not click-to-call", async () => {
    let processed = null;
    const result = await startAutonomousCall(1, 218, {
        Lead: {
            findById: async () => ({
                id: 218,
                phone: "9153011403",
                do_not_contact: 0,
                organization_id: 1,
            }),
            updateById: async (_id, fields) => ({
                id: 218,
                phone: "9153011403",
                organization_id: 1,
                ...fields,
            }),
        },
        scheduler: {
            processLeadAction: async (lead, flags) => {
                processed = { lead, flags };
                return { executed: true };
            },
        },
    });
    assert.equal(result.executed, true);
    assert.equal(result.action, "CALL");
    assert.equal(processed.lead.id, 218);
    assert.ok(processed.flags);
});

test("autonomous answer XML is Speak-only so the AI voice can talk", () => {
    const xml = plivoVoiceAdapter.generateAnswerXml({
        message: "Hello from Nova, this is an AI conversation.",
    });
    assert.match(xml, /<Speak/);
    assert.doesNotMatch(xml, /<Dial/);
    assert.doesNotMatch(xml, /MultiPartyCall/);
});

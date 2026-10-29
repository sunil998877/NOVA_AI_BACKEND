import { test } from "node:test";
import assert from "node:assert/strict";
import {
    toE164,
    toTelHref,
    suggestCallbackDisposition,
    buildConversationNotes,
    conversationFromCall,
} from "../services/ase/callbackCall.service.js";

test("callback phone helper builds a tel link for Indian mobiles", () => {
    assert.equal(toE164("8877563855"), "+918877563855");
    assert.equal(toTelHref("8877563855"), "tel:+918877563855");
    assert.equal(toTelHref(""), "");
});

test("recorded conversation notes include transcript for submit autofill", () => {
    const notes = buildConversationNotes({
        transcript: "Prospect asked for a callback next week.",
        durationSec: 42,
        outcome: "CALLBACK",
        recordingUrl: "https://example.com/rec.mp3",
    });
    assert.match(notes, /Recorded call · 42s/);
    assert.match(notes, /Prospect asked for a callback next week/);
    assert.match(notes, /rec\.mp3/);
});

test("call metadata maps to a callback disposition", () => {
    assert.equal(suggestCallbackDisposition("INTERESTED", "completed"), "connected_interested");
    assert.equal(suggestCallbackDisposition("CALLBACK", "completed"), "callback_requested");
    assert.equal(suggestCallbackDisposition("INITIATED", "busy"), "busy");
    assert.equal(suggestCallbackDisposition("INITIATED", "no-answer"), "no_answer");
});

test("conversationFromCall reads transcript from webhook payloads", () => {
    const convo = conversationFromCall(
        { duration_sec: 18, normalized_outcome: "INTERESTED", provider_status: "completed", raw_metadata: {} },
        [{ payload: { transcript: "Yes, send me the details." } }]
    );
    assert.equal(convo.transcript, "Yes, send me the details.");
    assert.equal(convo.suggestedOutcome, "connected_interested");
    assert.match(convo.notes, /Yes, send me the details/);
});

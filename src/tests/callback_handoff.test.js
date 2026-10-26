import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
    ASE_OUTCOMES,
    classifyProspectSpeech,
    normalizeTelephonyOutcome,
    normalizeChannelOutcome,
    shouldQueueHumanHandoff,
} from "../services/ase/outcomeNormalizer.service.js";
import { plivoVoiceAdapter } from "../services/ase/adapters/plivoVoice.adapter.js";
import { isHandoffBackfillLead } from "../models/callback.model.js";

describe("Callback queue handoff false positives", () => {
    test("Prospect asking to be called back queues a callback", () => {
        const classified = classifyProspectSpeech("Can you call me back later today?");
        assert.equal(classified.outcome, ASE_OUTCOMES.CALLBACK);
        assert.equal(classified.callbackRequested, true);
        assert.equal(shouldQueueHumanHandoff(classified.outcome, { isAnswered: true, callStatus: "completed" }), true);
    });

    test("Prospect interest without a live rep still qualifies for handoff", () => {
        const classified = classifyProspectSpeech("Sounds good, send details");
        assert.equal(classified.outcome, ASE_OUTCOMES.INTERESTED);
        assert.equal(shouldQueueHumanHandoff(classified.outcome, { isAnswered: true }), true);
    });

    test("Bot offering a demo or schedule with a silent prospect does not queue a callback", () => {
        const botOnly = [
            "Would you like to schedule a demo?",
            "Hello Sarah, this is Nova. I can schedule a callback and walk you through a demo.",
            "If you're interested I can send details and book a meeting.",
            "Agent: Would you like to schedule a demo next Tuesday?\nProspect:",
        ];

        for (const transcript of botOnly) {
            const classified = classifyProspectSpeech(transcript);
            const telephony = normalizeTelephonyOutcome({
                Status: "completed",
                Duration: "18",
                BillDuration: "18",
                AnswerTime: "2026-10-26 10:00:00",
                SpeechResult: transcript,
            });
            assert.equal(classified.outcome, ASE_OUTCOMES.AMBIGUOUS, `classify: ${transcript}`);
            assert.equal(telephony.normalizedOutcome, ASE_OUTCOMES.AMBIGUOUS, `telephony: ${transcript}`);
            assert.equal(shouldQueueHumanHandoff(telephony.normalizedOutcome, { isAnswered: true, callStatus: "completed" }), false);
        }
    });

    test("Prospect explicitly asking for a demo still counts as interested", () => {
        const answered = normalizeTelephonyOutcome({
            Status: "completed",
            Duration: "45",
            SpeechResult: "Yes, I would like to schedule a demo next Tuesday.",
        });
        assert.equal(answered.isAnswered, true);
        assert.equal(answered.normalizedOutcome, ASE_OUTCOMES.INTERESTED);
        assert.equal(shouldQueueHumanHandoff(answered.normalizedOutcome, { isAnswered: true, callStatus: "completed" }), true);
    });

    test("No-answer and busy never create a human handoff", () => {
        const busy = normalizeTelephonyOutcome({ Status: "busy", Duration: "0" });
        const noAnswer = normalizeTelephonyOutcome({ Status: "no-answer", Duration: "0" });
        const timeout = normalizeTelephonyOutcome({ HangupCause: "ring timeout", Duration: "0" });

        assert.equal(busy.normalizedOutcome, ASE_OUTCOMES.BUSY);
        assert.equal(noAnswer.normalizedOutcome, ASE_OUTCOMES.NO_ANSWER);
        assert.equal(timeout.normalizedOutcome, ASE_OUTCOMES.RING_TIMEOUT);

        assert.equal(shouldQueueHumanHandoff(ASE_OUTCOMES.INTERESTED, { isAnswered: false, callStatus: "no-answer" }), false);
        assert.equal(shouldQueueHumanHandoff(ASE_OUTCOMES.CALLBACK, { isAnswered: false, callStatus: "busy" }), false);
        assert.equal(shouldQueueHumanHandoff(busy.normalizedOutcome, { callStatus: "busy" }), false);
        assert.equal(shouldQueueHumanHandoff(noAnswer.normalizedOutcome, { callStatus: "no-answer" }), false);
    });

    test("Page-open backfill only recovers real callback obligations", () => {
        assert.equal(isHandoffBackfillLead({ status: "INTERESTED" }), false);
        assert.equal(isHandoffBackfillLead({ status: "QUALIFIED" }), false);
        assert.equal(isHandoffBackfillLead({ status: "CONTACTED", next_action: "CALL" }), false);
        assert.equal(isHandoffBackfillLead({ status: "ENGAGED" }), false);

        assert.equal(isHandoffBackfillLead({ status: "CALLBACK_SCHEDULED" }), true);
        assert.equal(isHandoffBackfillLead({ status: "INTERESTED", next_action: "REP_CALLBACK" }), true);
        assert.equal(isHandoffBackfillLead({ status: "CONTACTED", callback_due: new Date() }), true);
        assert.equal(isHandoffBackfillLead({ status: "CALLBACK_SCHEDULED", do_not_contact: 1 }), false);
    });

    test("Voice adapter uses the same prospect-only classifier", () => {
        const silentBot = plivoVoiceAdapter.extractConversationOutcome("Would you like to schedule a demo?");
        const callback = plivoVoiceAdapter.extractConversationOutcome("can you please call me back later today");
        assert.equal(silentBot.outcome, ASE_OUTCOMES.AMBIGUOUS);
        assert.equal(callback.outcome, ASE_OUTCOMES.CALLBACK);
        assert.equal(callback.callbackRequested, true);
    });

    test("Bare 'tomorrow' in an email is not a callback request", () => {
        const outcome = normalizeChannelOutcome("EMAIL", {
            body: "I will review this tomorrow and get back to the team.",
        });
        assert.equal(outcome, ASE_OUTCOMES.AMBIGUOUS);
    });
});

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { Suppression } from "../models/suppression.model.js";
import { FollowUpEnrollment } from "../models/follow-up-enrollment.model.js";
import { aseDecisionEngine } from "../services/ase/brain/aseDecisionEngine.service.js";
import { decisionPolicyService } from "../services/ase/brain/decisionPolicy.service.js";
import { leadFeatureService } from "../services/ase/brain/leadFeature.service.js";
import { leadPriorityService } from "../services/ase/brain/leadPriority.service.js";
import { modelRegistry } from "../services/ase/brain/modelRegistry.service.js";
import { nextBestActionService } from "../services/ase/brain/nextBestAction.service.js";
import { conversionPredictionService } from "../services/ase/brain/conversionPrediction.service.js";

before(() => {
    FollowUpEnrollment.findActiveByLeadId = async () => null;
    Suppression.isSuppressed = async (_orgId, { email }) => {
        if (email === "suppressed@acme.com") {
            return { reason: "Opted out from marketing" };
        }
        return null;
    };
});

test("NOVA Brain: Eligible new lead receives immediate outreach recommendation", async () => {
    const lead = {
        id: 101,
        organization_id: 1,
        email: "fresh.lead@acme.com",
        status: "NEW",
        attempt_counters: { email: 0, voice: 0 },
        email_consent: { status: "GRANTED" },
        voice_consent: { status: "GRANTED" },
    };

    const decision = await aseDecisionEngine.evaluateLead(lead, { audit: false });
    assert.equal(decision.isEligible, true);
    assert.ok(decision.action === "EMAIL" || decision.action === "CALL");
    assert.equal(decision.delayHours, 0);
    assert.ok(decision.explanation.length > 0);
    assert.ok(decision.conversionPrediction);
    assert.equal(decision.conversionPrediction.targetLabel, "CONVERSION_OR_POSITIVE_REPLY");
});

test("NOVA Brain: DNC lead cannot receive an outbound recommendation", async () => {
    const lead = {
        id: 102,
        organization_id: 1,
        email: "dnc.lead@acme.com",
        status: "NEW",
        do_not_contact: 1,
        attempt_counters: { email: 0, voice: 0 },
    };

    const decision = await aseDecisionEngine.evaluateLead(lead, { audit: false });
    assert.equal(decision.isEligible, false);
    assert.equal(decision.action, null);
    assert.match(decision.reasonCode, /DNC|TERMINAL/);
});

test("NOVA Brain: Email consent alone cannot authorize a voice call", async () => {
    const lead = {
        id: 103,
        organization_id: 1,
        email: "email.only@acme.com",
        phone: "+15550192834",
        status: "NEW",
        attempt_counters: { email: 1, voice: 0 },
        email_consent: { status: "GRANTED" },
        voice_consent: { status: "DENIED" },
    };

    const features = leadFeatureService.extractFeatures(lead);
    const eligibility = await decisionPolicyService.evaluateEligibility(lead, features);
    assert.ok(!eligibility.candidateActions.includes("CALL"));
    assert.ok(eligibility.blockedReasons.includes("VOICE_CONSENT_NOT_GRANTED"));
});

test("NOVA Brain: Suppressed, closed, or terminal leads are blocked", async () => {
    for (const term of ["CLOSED_WON", "CLOSED_LOST", "SUPPRESSED_DNC"]) {
        const lead = {
            id: 104,
            organization_id: 1,
            email: "closed@acme.com",
            status: term,
        };
        const decision = await aseDecisionEngine.evaluateLead(lead, { audit: false });
        assert.equal(decision.isEligible, false);
        assert.equal(decision.action, null);
    }

    const suppressedLead = {
        id: 105,
        organization_id: 1,
        email: "suppressed@acme.com",
        status: "NEW",
    };
    const decision = await aseDecisionEngine.evaluateLead(suppressedLead, { audit: false });
    assert.equal(decision.isEligible, false);
    assert.equal(decision.action, null);
    assert.equal(decision.reasonCode, "SUPPRESSION_LIST_MATCH");
});

test("NOVA Brain: Model inference cannot override compliance rules", async () => {
    const lead = {
        id: 106,
        organization_id: 1,
        email: "fatigued@acme.com",
        phone: "+15550192834",
        status: "CONTACTED",
        attempt_counters: { email: 3, voice: 2 },
        email_consent: { status: "GRANTED" },
        voice_consent: { status: "GRANTED" },
    };

    const features = leadFeatureService.extractFeatures(lead);
    const eligibility = await decisionPolicyService.evaluateEligibility(lead, features);
    assert.equal(eligibility.candidateActions.length, 0);

    const mockMlPrediction = { available: true, action: "CALL", confidence: 0.99 };
    const decision = nextBestActionService.determineNextBestAction({
        eligibility,
        features,
        priority: { tier: "P3_NORMAL", score: 50 },
        prediction: mockMlPrediction,
    });

    assert.equal(decision.recommendedAction, null);
});

test("NOVA Brain: Safe fallback when brain mode is set to RULES_ONLY", async () => {
    modelRegistry.setMode("RULES_ONLY");
    const lead = {
        id: 107,
        organization_id: 1,
        email: "fallback@acme.com",
        status: "NEW",
        attempt_counters: { email: 0, voice: 0 },
        email_consent: { status: "GRANTED" },
    };

    const decision = await aseDecisionEngine.evaluateLead(lead, { audit: false });
    assert.equal(decision.action, "EMAIL");
    assert.equal(decision.isAssistedByMl, false);
    assert.equal(decision.modelVersion, "rules-only");

    modelRegistry.setMode("ACTIVE");
});

test("NOVA Brain: Shadow mode records shadow prediction without altering rules baseline", async () => {
    modelRegistry.setMode("SHADOW");
    const lead = {
        id: 108,
        organization_id: 1,
        email: "shadow@acme.com",
        status: "NEW",
        attempt_counters: { email: 0, voice: 0 },
        email_consent: { status: "GRANTED" },
    };

    const decision = await aseDecisionEngine.evaluateLead(lead, { audit: false });
    assert.equal(decision.isAssistedByMl, false);
    if (decision.shadowPrediction) {
        assert.ok(decision.shadowPrediction.action);
        assert.ok(typeof decision.shadowPrediction.confidence === "number");
    }

    modelRegistry.setMode("ACTIVE");
});

test("NOVA Brain: Priority service elevates pending callbacks to P1_URGENT", () => {
    const lead = {
        id: 109,
        priority: 50,
        callback_due: new Date(Date.now() - 60000).toISOString(),
    };
    const features = leadFeatureService.extractFeatures(lead);
    const priority = leadPriorityService.calculatePriority(lead, features);
    assert.equal(priority.tier, "P1_URGENT");
    assert.equal(priority.score, 100);
});

test("NOVA Brain: FastAPI model chooses the next action", async () => {
    modelRegistry.setMode("ACTIVE");
    const lead = {
        id: 203,
        organization_id: 1,
        email: "model@acme.com",
        phone: "+15550192834",
        status: "ENGAGED",
        email_opens: 3,
        link_clicks: 2,
        priority: 88,
        attempt_counters: { email: 1, voice: 0 },
        email_consent: { status: "GRANTED" },
        voice_consent: { status: "GRANTED" },
        last_contacted_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString(),
    };
    const decision = await aseDecisionEngine.evaluateLead(lead, { audit: false });
    assert.equal(decision.isAssistedByMl, true);
    assert.ok(["fastapi-onnx-sklearn", "onnxruntime"].includes(decision.provider));
    assert.ok(decision.action === "CALL" || decision.action === "EMAIL");
    if (decision.provider === "fastapi-onnx-sklearn") {
        assert.equal(decision.reasonCode, "ML_MODEL_DECISION");
        assert.equal(decision.action, "CALL");
    }
    assert.ok(decision.probabilities);
    const total = decision.probabilities.EMAIL + decision.probabilities.CALL + decision.probabilities.WAIT;
    assert.ok(Math.abs(total - 1) < 0.02);
});

test("NOVA Brain: Conversion prediction service produces calibrated 14-day estimates", () => {
    const features = {
        emailOpens: 2,
        linkClicks: 1,
        voiceAttempts: 0,
        hoursSinceLastTouch: 24.0,
        engagementScore: 65.0,
    };
    const result = conversionPredictionService.predictConversionProbability(features, null);
    assert.equal(result.targetLabel, "CONVERSION_OR_POSITIVE_REPLY");
    assert.equal(result.horizonDays, 14);
    assert.equal(result.predictionStatus, "SUCCESS");
    assert.ok(result.probability > 0 && result.probability <= 1);
    assert.ok(result.confidence > 0 && result.confidence <= 1);
});

test("NOVA Brain: Interested leads get a higher conversion chance than new leads", () => {
    const base = { emailOpens: 0, linkClicks: 0, voiceAttempts: 0, hoursSinceLastTouch: 48, engagementScore: 15 };
    const cold = conversionPredictionService.predictConversionProbability({ ...base, status: "NEW" }, {
        available: true,
        action: "WAIT",
        confidence: 0.84,
        probabilities: { EMAIL: 0.08, CALL: 0.08, WAIT: 0.84 },
    });
    const hot = conversionPredictionService.predictConversionProbability({ ...base, status: "INTERESTED" }, {
        available: true,
        action: "EMAIL",
        confidence: 0.7,
        probabilities: { EMAIL: 0.70, CALL: 0.10, WAIT: 0.20 },
    });
    assert.ok(hot.probability > cold.probability);
    assert.ok(hot.probability >= 0.08);
});

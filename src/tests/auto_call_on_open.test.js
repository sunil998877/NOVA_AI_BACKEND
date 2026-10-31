import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectDb, closeDb } from "../config/db.js";
import { OrchestratorService } from "../services/ase/orchestrator.service.js";
import { validateDispatchEligibility } from "../services/ase/complianceGate.service.js";
import { transitionLeadState } from "../services/ase/leadStateMachine.js";
import { detectEmailScanner } from "../utils/emailScannerDetector.js";
import { isWithinCallingHours, calculateNextCallingTime } from "../services/ase/callingHours.service.js";
import { voiceAdapter } from "../services/ase/adapters/voice.adapter.js";
import { normalizeTelephonyOutcome, ASE_OUTCOMES } from "../services/ase/outcomeNormalizer.service.js";
import { Lead } from "../models/lead.model.js";

describe("Automatic AI Calling After Email Opens in NOVA + ASE", () => {
  before(async () => {
    try {
      await connectDb();
    } catch (_) {}
  });

  after(async () => {
    try {
      await closeDb();
    } catch (_) {}
  });

  test("1. Lead lifecycle transition on email open: Contacted -> Engaged (not interested/qualified)", () => {
    const contactedTransition = transitionLeadState("CONTACTED", "EMAIL_ENGAGED");
    assert.equal(contactedTransition.changed, true);
    assert.equal(contactedTransition.nextState, "ENGAGED");

    const terminalTransition = transitionLeadState("CLOSED_WON", "EMAIL_ENGAGED");
    assert.equal(terminalTransition.changed, false);
    assert.equal(terminalTransition.nextState, "CLOSED_WON");

    const engagedTransition = transitionLeadState("ENGAGED", "DISPATCH_CALL");
    assert.equal(engagedTransition.nextState, "ENGAGED");
  });

  test("2. Scanner / privacy proxy detection filters automated bot opens", () => {
    const googleProxy = detectEmailScanner("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 GoogleImageProxy");
    assert.equal(googleProxy.isScanner, true);
    assert.equal(googleProxy.scannerType, "GOOGLE_IMAGE_PROXY");

    const appleProxy = detectEmailScanner("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)");
    assert.equal(appleProxy.isScanner, true);
    assert.equal(appleProxy.scannerType, "APPLE_PRIVACY_PROXY");

    const humanUser = detectEmailScanner("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0");
    assert.equal(humanUser.isScanner, false);
    assert.equal(humanUser.scannerType, null);
  });

  test("3. Calling hours evaluation ensures compliance with allowed windows", () => {
    const inHours = isWithinCallingHours({ phone: "+919876543210" }, {
      startHour: 0,
      endHour: 24,
    });
    assert.equal(inHours, true);

    const outHours = isWithinCallingHours({ phone: "+919876543210" }, {
      startHour: 25,
      endHour: 26,
    });
    assert.equal(outHours, false);

    const nextTime = calculateNextCallingTime({ phone: "+919876543210" }, {
      delaySeconds: 15,
      startHour: 9,
      endHour: 20,
    });
    assert.ok(nextTime instanceof Date);
    assert.ok(nextTime.getTime() >= Date.now());
  });

  test("4. Compliance gate blocks leads without voice consent", async () => {
    const leadNoConsent = {
      id: 9991,
      organization_id: 1,
      email: "prospect@example.com",
      phone: "+15551234567",
      voice_consent: { status: "DENIED" },
      attempt_counters: { email: 1, voice: 0, total: 1 },
      status: "ENGAGED",
    };

    const eligibility = await validateDispatchEligibility(leadNoConsent, "CALL", {
      isEngagementTrigger: true,
      bypassCallingHours: true,
    });
    assert.equal(eligibility.eligible, false);
    assert.match(eligibility.reason, /Voice consent has been denied/);
  });

  test("5. Compliance gate blocks DNC or suppressed leads", async () => {
    const leadDnc = {
      id: 9992,
      organization_id: 1,
      email: "dnc@example.com",
      phone: "+15551234568",
      do_not_contact: 1,
      voice_consent: { status: "GRANTED" },
      attempt_counters: { email: 1, voice: 0, total: 1 },
      status: "ENGAGED",
    };

    const eligibility = await validateDispatchEligibility(leadDnc, "CALL", {
      isEngagementTrigger: true,
      bypassCallingHours: true,
    });
    assert.equal(eligibility.eligible, false);
    assert.match(eligibility.reason, /do_not_contact/);
  });

  test("6. Compliance gate blocks leads exceeding max voice call fatigue limits", async () => {
    const leadExhausted = {
      id: 9993,
      organization_id: 1,
      email: "maxcalls@example.com",
      phone: "+15551234569",
      voice_consent: { status: "GRANTED" },
      attempt_counters: { email: 1, voice: 2, total: 3 },
      status: "ENGAGED",
    };

    const eligibility = await validateDispatchEligibility(leadExhausted, "CALL", {
      isEngagementTrigger: true,
      bypassCallingHours: true,
    });
    assert.equal(eligibility.eligible, false);
    assert.match(eligibility.reason, /Maximum call fatigue limit reached/);
  });

  test("7. Compliance gate blocks terminal state leads", async () => {
    const leadWon = {
      id: 9994,
      organization_id: 1,
      email: "won@example.com",
      phone: "+15551234570",
      status: "CLOSED_WON",
    };

    const eligibility = await validateDispatchEligibility(leadWon, "CALL");
    assert.equal(eligibility.eligible, false);
    assert.match(eligibility.reason, /terminal state/);
  });

  test("8. Email open never dispatches an autonomous call", async () => {
    const mockLead = {
      id: 8881,
      organization_id: 1,
      email: "eligible.open@company.org",
      phone: "+15557778899",
      status: "CONTACTED",
      voice_consent: { status: "GRANTED" },
      attempt_counters: { email: 1, voice: 0, total: 1 },
      do_not_contact: 0,
    };

    const result = await OrchestratorService.handleEmailOpen(mockLead, {
      mailId: 777,
      campaignId: 44,
      isScanner: false,
    });

    assert.equal(result.handled, true);
    assert.equal(result.callScheduled, false);
    assert.match(result.reason, /does not dispatch a call/i);
  });

  test("9. Scanner opens also do not dispatch a call", async () => {
    const mockLead = {
      id: 8882,
      organization_id: 1,
      email: "bot.open@company.org",
      phone: "+15557778890",
      status: "CONTACTED",
      voice_consent: { status: "GRANTED" },
      attempt_counters: { email: 1, voice: 0, total: 1 },
      do_not_contact: 0,
    };

    const result = await OrchestratorService.handleEmailOpen(mockLead, {
      mailId: 778,
      campaignId: 44,
      isScanner: true,
      scannerType: "AUTOMATED_SCANNER",
    });

    assert.equal(result.handled, true);
    assert.equal(result.callScheduled, false);
  });

  test("10. Voice bot adapter executes call with simulated fallback when provider unconfigured", async () => {
    const lead = {
      id: 8883,
      organization_id: 1,
      phone: "+15553334444",
      name: "Alex Taylor",
    };

    const execution = await voiceAdapter.execute(lead, "CALL", {
      callId: 9001,
      prompt: "Hello Alex, this is Nova following up on your email open.",
    });

    assert.ok(execution);
    assert.equal(execution.channel, "VOICE");
    assert.equal(execution.status, "SUCCEEDED");
    assert.ok(execution.metadata?.providerCallId);
  });

  test("11. Call outcomes properly normalized to update lead state", () => {
    const answeredPayload = {
      Status: "completed",
      Duration: "45",
      CallDuration: "45",
      SpeechResult: "Yes, I would like to schedule a demo next Tuesday.",
    };
    const answeredOutcome = normalizeTelephonyOutcome(answeredPayload);
    assert.equal(answeredOutcome.isAnswered, true);
    assert.equal(answeredOutcome.normalizedOutcome, ASE_OUTCOMES.INTERESTED);

    const busyPayload = {
      Status: "busy",
      Duration: "0",
    };
    const busyOutcome = normalizeTelephonyOutcome(busyPayload);
    assert.equal(busyOutcome.isAnswered, false);
    assert.equal(busyOutcome.normalizedOutcome, ASE_OUTCOMES.BUSY);

    const noAnswerPayload = {
      Status: "no-answer",
      Duration: "0",
    };
    const noAnswerOutcome = normalizeTelephonyOutcome(noAnswerPayload);
    assert.equal(noAnswerOutcome.isAnswered, false);
    assert.equal(noAnswerOutcome.normalizedOutcome, ASE_OUTCOMES.NO_ANSWER);
  });
});

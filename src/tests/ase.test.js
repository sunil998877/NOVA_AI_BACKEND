import { normalizeLead } from "../services/leads/leadIntake.service.js";
import { normalizeChannelOutcome, ASE_OUTCOMES } from "../services/ase/outcomeNormalizer.service.js";
import { OrchestratorService } from "../services/ase/orchestrator.service.js";

export async function runAseTests() {
    const results = [];
    const assert = (name, condition) => {
        if (condition) {
            results.push({ name, passed: true });
        } else {
            results.push({ name, passed: false });
            console.error(`Assertion failed: ${name}`);
        }
    };

    try {
        const lead = normalizeLead({
            email: "Test.Lead@Company.com",
            firstName: "Alex",
            lastName: "Smith",
            company: "Acme Corp",
            phone: "+1 (555) 019-2834",
            priority: 85,
        });

        assert("Normalization lowercases email", lead.email === "test.lead@company.com");
        assert("Normalization sets full name", lead.name === "Alex Smith");
        assert("Normalization cleans phone numbers", lead.phone === "+15550192834");
        assert("Normalization assigns custom priority", lead.priority === 85);
        assert("Normalization sets default consents", lead.email_consent?.status === "GRANTED");

        let thrown = false;
        try {
            normalizeLead({ name: "No Email" });
        } catch (_) {
            thrown = true;
        }
        assert("Validation rejects missing email", thrown);

        assert("Normalizer detects DNC intent", normalizeChannelOutcome("VOICE", { transcript: "Please stop calling me and unsubscribe" }) === ASE_OUTCOMES.DNC);
        assert("Normalizer detects callback request", normalizeChannelOutcome("VOICE", { detectedIntent: "callback", transcript: "Call me back tomorrow" }) === ASE_OUTCOMES.CALLBACK);
        assert("Normalizer detects interested intent", normalizeChannelOutcome("VOICE", { transcript: "Sounds good, send details" }) === ASE_OUTCOMES.INTERESTED);
        assert("Normalizer detects not interested", normalizeChannelOutcome("VOICE", { transcript: "No thanks not interested" }) === ASE_OUTCOMES.NOT_INTERESTED);

        const terminalLead = {
            id: 999,
            organization_id: 1,
            email: "won@test.com",
            status: "CLOSED_WON",
        };
        const evalWon = await OrchestratorService.evaluateNextAction(terminalLead);
        assert("Orchestrator halts outreach on terminal CLOSED_WON", evalWon.action === null);

        const dncLead = {
            id: 998,
            organization_id: 1,
            email: "dnc@test.com",
            do_not_contact: 1,
            status: "NEW",
        };
        const evalDnc = await OrchestratorService.evaluateNextAction(dncLead);
        assert("Orchestrator halts outreach on DNC flag", evalDnc.action === null);

        const exhaustedLead = {
            id: 997,
            organization_id: 1,
            email: "fatigued@test.com",
            phone: "+15550192834",
            status: "CONTACTED",
            attempt_counters: { email: 3, voice: 2, total: 5 },
            email_consent: { status: "GRANTED" },
            voice_consent: { status: "GRANTED" },
        };
        const evalFatigue = await OrchestratorService.evaluateNextAction(exhaustedLead);
        assert("Orchestrator enforces fatigue limits (max 3 emails, max 2 calls)", evalFatigue.action === null);

        const freshLead = {
            id: 996,
            organization_id: 1,
            email: "fresh@test.com",
            phone: "+15550192834",
            status: "NEW",
            attempt_counters: { email: 0, voice: 0, total: 0 },
            email_consent: { status: "GRANTED" },
            voice_consent: { status: "GRANTED" },
        };
        const evalFresh = await OrchestratorService.evaluateNextAction(freshLead);
        assert("Orchestrator schedules initial EMAIL for fresh lead", evalFresh.action === "EMAIL");

        console.log(`[ASE Tests] Completed: ${results.filter(r => r.passed).length}/${results.length} passed.`);
    } catch (err) {
        console.error("[ASE Tests] Error executing tests:", err);
    }

    return results;
}

import { normalizeLead } from "../services/leads/leadIntake.service.js";
import { parseCsv, csvToLeads, autoDetectMapping } from "../services/leads/csvParser.js";
import { OrchestratorService } from "../services/ase/orchestrator.service.js";
import { normalizeChannelOutcome, ASE_OUTCOMES } from "../services/ase/outcomeNormalizer.service.js";
import { validateDispatchEligibility } from "../services/ase/complianceGate.service.js";
import { transitionLeadState, TERMINAL_STATES } from "../services/ase/leadStateMachine.js";
import { eventBus } from "../services/ase/eventBus.service.js";
import { plivoVoiceAdapter } from "../services/ase/adapters/plivoVoice.adapter.js";
import { jobQueue } from "../services/ase/jobQueue.service.js";
import { connectDb } from "../config/db.js";

export async function runAseIntegrationTests() {
    const results = [];
    const assert = (name, condition) => {
        if (condition) {
            results.push({ name, passed: true });
        } else {
            results.push({ name, passed: false });
            console.error(`[Integration Test Failed]: ${name}`);
        }
    };

    try {
        try {
            await connectDb();
        } catch (_) {}


        const lead = normalizeLead({
            email: "  Jane.Doe@AcmeEnterprise.com ",
            firstName: "Jane",
            lastName: "Doe",
            phone: "+1 (555) 019-4820",
            priority: 95,
            tags: "enterprise, vip",
            company: "Acme Enterprise",
        });

        assert("Normalization sanitizes email", lead.email === "jane.doe@acmeenterprise.com");
        assert("Normalization combines name", lead.name === "Jane Doe");
        assert("Normalization strips invalid characters from phone", lead.phone === "+15550194820");
        assert("Normalization parses priority score", lead.priority === 95);
        assert("Normalization parses tags into set array", Array.isArray(lead.tags) && lead.tags.includes("enterprise") && lead.tags.includes("vip"));
        assert("Normalization leaves consent unknown until it is explicitly granted", lead.email_consent?.status === "UNKNOWN" && lead.voice_consent?.status === "UNKNOWN");

        let missingEmailRejected = false;
        try {
            normalizeLead({ name: "No Email Record" });
        } catch (_) {
            missingEmailRejected = true;
        }
        assert("Validation rejects record missing email", missingEmailRejected);

        let invalidEmailRejected = false;
        try {
            normalizeLead({ email: "not-an-email" });
        } catch (_) {
            invalidEmailRejected = true;
        }
        assert("Validation rejects malformed email syntax", invalidEmailRejected);

        const rawCsv = `"Work Email","Full Name","Company","Mobile Phone"\n"carol@test.com","Carol Danvers","Avenger LLC","+15550192345"\n"bruce@test.com","Bruce Banner","Banner Labs","+15550198888"`;
        const parsed = csvToLeads(rawCsv);
        assert("CSV parser extracts all data rows", parsed.leads.length === 2);
        assert("CSV parser auto maps headers", parsed.mapping.email !== undefined && parsed.mapping.name !== undefined);
        assert("CSV parser extracts cell data correctly", parsed.leads[0].email === "carol@test.com" && parsed.leads[1].name === "Bruce Banner");

        const tsv = "Email\tName\tCompany\ntony@stark.com\tTony Stark\tStark Ind";
        const parsedTsv = csvToLeads(tsv);
        assert("CSV parser auto detects TSV tab delimiter", parsedTsv.leads.length === 1 && parsedTsv.leads[0].email === "tony@stark.com");

        const semicolonCsv = "Email;Name;Company\nthor@asgard.org;Thor Odinson;Asgard";
        const parsedSemicolon = csvToLeads(semicolonCsv);
        assert("CSV parser auto detects European semicolon delimiter", parsedSemicolon.leads.length === 1 && parsedSemicolon.leads[0].email === "thor@asgard.org");

        const freshLead = {
            id: 101,
            organization_id: 1,
            email: "fresh@corp.com",
            phone: "+15550192834",
            status: "NEW",
            attempt_counters: { email: 0, voice: 0, total: 0 },
            email_consent: { status: "GRANTED" },
            voice_consent: { status: "GRANTED" },
            do_not_contact: 0,
        };
        const freshDecision = await OrchestratorService.evaluateNextAction(freshLead);
        assert("Orchestrator schedules EMAIL first for fresh lead", freshDecision.action === "EMAIL");

        const contactedLead = {
            id: 102,
            organization_id: 1,
            email: "contacted@corp.com",
            phone: "+15550192834",
            status: "CONTACTED",
            attempt_counters: { email: 2, voice: 0, total: 2 },
            email_consent: { status: "GRANTED" },
            voice_consent: { status: "GRANTED" },
            do_not_contact: 0,
        };
        const contactedDecision = await OrchestratorService.evaluateNextAction(contactedLead);
        assert("Orchestrator alternates to CALL after email sequence", contactedDecision.action === "CALL");

        const exhaustedLead = {
            id: 103,
            organization_id: 1,
            email: "exhausted@corp.com",
            phone: "+15550192834",
            status: "CONTACTED",
            attempt_counters: { email: 3, voice: 2, total: 5 },
            email_consent: { status: "GRANTED" },
            voice_consent: { status: "GRANTED" },
            do_not_contact: 0,
        };
        const exhaustedDecision = await OrchestratorService.evaluateNextAction(exhaustedLead);
        assert("Orchestrator enforces contact fatigue caps", exhaustedDecision.action === null);

        const terminalWonLead = {
            id: 104,
            organization_id: 1,
            email: "won@corp.com",
            status: "CLOSED_WON",
            do_not_contact: 0,
        };
        const wonDecision = await OrchestratorService.evaluateNextAction(terminalWonLead);
        assert("Orchestrator halts outreach on terminal CLOSED_WON", wonDecision.action === null);

        const dncFlaggedLead = {
            id: 105,
            organization_id: 1,
            email: "dnc@corp.com",
            status: "NEW",
            do_not_contact: 1,
        };
        const dncDecision = await OrchestratorService.evaluateNextAction(dncFlaggedLead);
        assert("Orchestrator halts outreach on do_not_contact", dncDecision.action === null);

        const gatePassed = await validateDispatchEligibility(freshLead, "EMAIL");
        assert("Compliance gate allows eligible fresh lead", gatePassed.eligible === true);

        const gateTerminal = await validateDispatchEligibility(terminalWonLead, "EMAIL");
        assert("Compliance gate blocks terminal state", gateTerminal.eligible === false);

        const gateDnc = await validateDispatchEligibility(dncFlaggedLead, "EMAIL");
        assert("Compliance gate blocks do_not_contact", gateDnc.eligible === false);

        const gateDeniedConsent = await validateDispatchEligibility({
            ...freshLead,
            email_consent: { status: "DENIED" },
        }, "EMAIL");
        assert("Compliance gate blocks denied email consent", gateDeniedConsent.eligible === false);

        const gateUnknownConsent = await validateDispatchEligibility({
            ...freshLead,
            email_consent: { status: "UNKNOWN" },
        }, "EMAIL");
        assert("Compliance gate blocks unknown email consent", gateUnknownConsent.eligible === false);

        const gateDeniedVoice = await validateDispatchEligibility({
            ...freshLead,
            voice_consent: { status: "DENIED" },
        }, "CALL");
        assert("Compliance gate blocks denied voice consent", gateDeniedVoice.eligible === false);

        const outcomeDnc = normalizeChannelOutcome("VOICE", { transcript: "Please stop calling me and unsubscribe" });
        assert("Outcome normalizer detects DNC opt-out", outcomeDnc === ASE_OUTCOMES.DNC);

        const outcomeCb = normalizeChannelOutcome("VOICE", { transcript: "I am interested please call me back tomorrow" });
        assert("Outcome normalizer detects callback intent", outcomeCb === ASE_OUTCOMES.CALLBACK);

        const outcomePositive = normalizeChannelOutcome("VOICE", { transcript: "Yes send me more information sounds good" });
        assert("Outcome normalizer detects positive interest", outcomePositive === ASE_OUTCOMES.INTERESTED);

        const outcomeNegative = normalizeChannelOutcome("VOICE", { transcript: "Not interested thanks" });
        assert("Outcome normalizer detects negative objection", outcomeNegative === ASE_OUTCOMES.NOT_INTERESTED);

        const t1 = transitionLeadState("NEW", "DISPATCH_EMAIL");
        assert("XState transition: NEW + DISPATCH_EMAIL -> QUEUED", t1.nextState === "QUEUED" && t1.changed === true);

        const t2 = transitionLeadState("QUEUED", "EMAIL_SENT");
        assert("XState transition: QUEUED + EMAIL_SENT -> CONTACTED", t2.nextState === "CONTACTED" && t2.changed === true);

        const t3 = transitionLeadState("CONTACTED", "INTEREST_DETECTED");
        assert("XState transition: CONTACTED + INTEREST_DETECTED -> INTERESTED", t3.nextState === "INTERESTED" && t3.changed === true);

        const t4 = transitionLeadState("INTERESTED", "CALLBACK_REQUESTED");
        assert("XState transition: INTERESTED + CALLBACK_REQUESTED -> CALLBACK_SCHEDULED", t4.nextState === "CALLBACK_SCHEDULED" && t4.changed === true);

        const t5 = transitionLeadState("CALLBACK_SCHEDULED", "SUPPRESS_DNC");
        assert("XState transition: CALLBACK_SCHEDULED + SUPPRESS_DNC -> SUPPRESSED_DNC", t5.nextState === "SUPPRESSED_DNC" && t5.changed === true);

        const t6 = transitionLeadState("SUPPRESSED_DNC", "DISPATCH_EMAIL");
        assert("XState terminal guard: SUPPRESSED_DNC blocks outreach progression", t6.nextState === "SUPPRESSED_DNC" && t6.changed === false);

        const envelope = eventBus.createEnvelope("LeadAccepted", { lead_id: 101, source: "API" });
        assert("EventBus creates versioned envelope", envelope.version === "1.0" && envelope.event_type === "LeadAccepted" && Boolean(envelope.correlation_id));

        const plivoXml = plivoVoiceAdapter.generateAnswerXml({ leadName: "Sarah" });
        assert("Plivo Voice adapter generates valid Speak XML", plivoXml.includes("<Speak") && plivoXml.includes("Sarah"));

        const plivoExtractedDnc = plivoVoiceAdapter.extractConversationOutcome("take me off your list and do not call");
        assert("Plivo AI outcome extraction detects DNC request", plivoExtractedDnc.outcome === ASE_OUTCOMES.DNC && plivoExtractedDnc.isDnc === true);

        const plivoExtractedCb = plivoVoiceAdapter.extractConversationOutcome("can you please call me back later today");
        assert("Plivo AI outcome extraction detects Callback request", plivoExtractedCb.outcome === ASE_OUTCOMES.CALLBACK && plivoExtractedCb.callbackRequested === true);

        const queueRes = await jobQueue.enqueueAction({ leadId: 101, action: "EMAIL", delayMs: 1000 });
        assert("JobQueue enqueues delayed action", queueRes.enqueued === true && Boolean(queueRes.jobId));

        console.log(`[ASE Integration Tests] Total: ${results.length}, Passed: ${results.filter(r => r.passed).length}`);
    } catch (err) {
        console.error("[ASE Integration Tests] Execution error:", err);
    }

    return results;
}

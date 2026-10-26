import { ASE_OUTCOMES, normalizeChannelOutcome } from "../outcomeNormalizer.service.js";

const DNC_PATTERN = /\b(unsubscribe|do not contact|don't contact|dont contact|stop emailing|stop calling|remove me|opt[\s-]?out|dnc)\b/i;

const INTENT_BY_OUTCOME = {
    [ASE_OUTCOMES.DNC]: { intent: "unsubscribe_or_dnc", suggestedNextAction: "SUPPRESS_DNC" },
    [ASE_OUTCOMES.NOT_INTERESTED]: { intent: "not_interested", suggestedNextAction: "CLOSE_LOST" },
    [ASE_OUTCOMES.INTERESTED]: { intent: "interested", suggestedNextAction: "REQUEST_HUMAN_REVIEW" },
    [ASE_OUTCOMES.CALLBACK]: { intent: "requests_callback", suggestedNextAction: "CREATE_CALLBACK" },
    [ASE_OUTCOMES.OOO]: { intent: "out_of_office", suggestedNextAction: "WAIT" },
    [ASE_OUTCOMES.AMBIGUOUS]: { intent: "ambiguous", suggestedNextAction: "REQUEST_HUMAN_REVIEW" },
};

export function classifyInteractionIntent(text, { channel = "EMAIL", subject = "" } = {}) {
    const source = `${subject || ""}\n${text || ""}`.slice(0, 4000);
    const evidence = source.replace(/\s+/g, " ").trim().slice(0, 280);
    if (DNC_PATTERN.test(source)) {
        return {
            intent: "unsubscribe_or_dnc",
            confidence: 1,
            suggestedNextAction: "SUPPRESS_DNC",
            evidence,
            method: "deterministic_rule",
            modelVersion: "intent-rules-v1",
            classifiedAt: new Date().toISOString(),
        };
    }

    const outcome = normalizeChannelOutcome(channel, {
        transcript: source,
        body: source,
        reply: source,
        subject,
    });
    const mapped = INTENT_BY_OUTCOME[outcome] || INTENT_BY_OUTCOME[ASE_OUTCOMES.AMBIGUOUS];
    return {
        intent: mapped.intent,
        confidence: outcome === ASE_OUTCOMES.AMBIGUOUS ? null : 0.7,
        suggestedNextAction: mapped.suggestedNextAction,
        evidence,
        method: "outcome_normalizer",
        outcome,
        modelVersion: "intent-rules-v1",
        classifiedAt: new Date().toISOString(),
    };
}

export const ASE_OUTCOMES = Object.freeze({
    INTERESTED: "OUTCOME_INTERESTED",
    NOT_INTERESTED: "OUTCOME_NOT_INTERESTED",
    CALLBACK: "OUTCOME_CALLBACK",
    PRICING: "OUTCOME_PRICING",
    WRONG_PERSON: "OUTCOME_WRONG_PERSON",
    DNC: "OUTCOME_DNC",
    OOO: "OUTCOME_OOO",
    NO_ANSWER: "OUTCOME_NO_ANSWER",
    VOICEMAIL: "OUTCOME_VOICEMAIL",
    AMBIGUOUS: "OUTCOME_AMBIGUOUS",
});

export function normalizeChannelOutcome(channel, rawResponse = {}) {
    if (!rawResponse) return ASE_OUTCOMES.AMBIGUOUS;

    const intent = String(rawResponse.detectedIntent || rawResponse.intent || "").toLowerCase();
    const disposition = String(rawResponse.disposition || rawResponse.status || "").toLowerCase();
    const text = String(rawResponse.transcript || rawResponse.body || rawResponse.reply || "").toLowerCase();

    if (
        disposition.includes("dnc") ||
        disposition.includes("do_not_call") ||
        disposition.includes("unsubscribe") ||
        intent.includes("dnc") ||
        text.includes("unsubscribe") ||
        text.includes("remove me") ||
        text.includes("stop calling") ||
        text.includes("do not call")
    ) {
        return ASE_OUTCOMES.DNC;
    }

    if (
        intent.includes("callback") ||
        disposition.includes("callback") ||
        text.includes("call me back") ||
        text.includes("call later") ||
        text.includes("tomorrow")
    ) {
        return ASE_OUTCOMES.CALLBACK;
    }

    if (
        intent.includes("not_interested") ||
        disposition.includes("not_interested") ||
        text.includes("not interested") ||
        text.includes("not_interested") ||
        text.includes("no thanks") ||
        text.includes("don't contact") ||
        text.includes("dont contact")
    ) {
        return ASE_OUTCOMES.NOT_INTERESTED;
    }

    if (
        intent.includes("interested") ||
        disposition.includes("interested") ||
        text.includes("interested") ||
        text.includes("i'm interested") ||
        text.includes("i am interested") ||
        text.includes("yes, i am") ||
        text.includes("sounds good") ||
        text.includes("tell me more") ||
        text.includes("send details") ||
        text.includes("let's talk") ||
        text.includes("let's connect") ||
        text.includes("book a call")
    ) {
        return ASE_OUTCOMES.INTERESTED;
    }

    if (intent.includes("pricing") || text.includes("pricing") || text.includes("how much")) {
        return ASE_OUTCOMES.PRICING;
    }

    if (intent.includes("wrong_person") || text.includes("wrong number") || text.includes("wrong person")) {
        return ASE_OUTCOMES.WRONG_PERSON;
    }

    if (disposition.includes("voicemail") || disposition.includes("answering_machine")) {
        return ASE_OUTCOMES.VOICEMAIL;
    }

    if (disposition.includes("no_answer") || disposition.includes("busy") || disposition.includes("failed")) {
        return ASE_OUTCOMES.NO_ANSWER;
    }

    if (disposition.includes("connected") || disposition.includes("delivered") || disposition.includes("sent")) {
        return ASE_OUTCOMES.AMBIGUOUS;
    }

    return ASE_OUTCOMES.AMBIGUOUS;
}

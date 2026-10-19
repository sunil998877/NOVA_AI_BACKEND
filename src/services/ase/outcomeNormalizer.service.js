export const ASE_OUTCOMES = Object.freeze({
    INTERESTED: "OUTCOME_INTERESTED",
    NOT_INTERESTED: "OUTCOME_NOT_INTERESTED",
    CALLBACK: "OUTCOME_CALLBACK",
    PRICING: "OUTCOME_PRICING",
    WRONG_PERSON: "OUTCOME_WRONG_PERSON",
    DNC: "OUTCOME_DNC",
    OOO: "OUTCOME_OOO",
    NO_ANSWER: "OUTCOME_NO_ANSWER",
    RING_TIMEOUT: "OUTCOME_RING_TIMEOUT",
    BUSY: "OUTCOME_BUSY",
    FAILED: "OUTCOME_FAILED",
    CANCELED: "OUTCOME_CANCELED",
    REJECTED: "OUTCOME_REJECTED",
    VOICEMAIL: "OUTCOME_VOICEMAIL",
    AMBIGUOUS: "OUTCOME_AMBIGUOUS",
});

export const TELEPHONY_TECHNICAL_STATUS = Object.freeze({
    INITIATED: "INITIATED",
    QUEUED: "QUEUED",
    RINGING: "RINGING",
    EARLY_MEDIA: "EARLY_MEDIA",
    IN_PROGRESS: "IN_PROGRESS",
    ANSWERED: "ANSWERED",
    COMPLETED: "COMPLETED",
    NO_ANSWER: "NO_ANSWER",
    RING_TIMEOUT: "RING_TIMEOUT",
    BUSY: "BUSY",
    FAILED: "FAILED",
    CANCELED: "CANCELED",
    REJECTED: "REJECTED",
    VOICEMAIL: "VOICEMAIL",
});

export function normalizeTelephonyOutcome(raw = {}) {
    if (!raw) {
        return {
            technicalStatus: TELEPHONY_TECHNICAL_STATUS.FAILED,
            status: "failed",
            normalizedOutcome: ASE_OUTCOMES.FAILED,
            isAnswered: false,
            disposition: "failed",
            businessDisposition: "FAILED",
            reason: "Empty provider payload",
            durationSeconds: 0,
            billableDurationSeconds: 0,
            providerCost: null,
            hangupCause: "",
            answeredAt: null,
            completedAt: null,
        };
    }

    const providerStatus = String(raw.CallStatus || raw.call_status || raw.Status || raw.status || raw.call_state || "").toLowerCase().trim();
    const hangupCause = String(raw.HangupCause || raw.hangup_cause || raw.hangup_cause_name || "").toLowerCase().trim();
    const duration = Number(raw.Duration || raw.call_duration || raw.duration_sec || raw.CallDuration || 0);
    const billDuration = Number(raw.BillDuration || raw.billed_duration || raw.billable_duration_sec || 0);
    const hasAnswerTime = Boolean(raw.AnswerTime || raw.answer_time);
    const speechResult = String(raw.SpeechResult || raw.transcript || raw.Text || raw.text || "").toLowerCase().trim();
    const isExplicitAnswerWebhook = Boolean(raw.isAnswerWebhook);
    const providerCost = raw.TotalCost != null ? Number(raw.TotalCost) : (raw.cost != null ? Number(raw.cost) : null);
    const answeredAt = raw.AnswerTime || raw.answer_time || null;
    const completedAt = raw.EndTime || raw.end_time || null;

    const buildResult = (technicalStatus, normalizedOutcome, isAnswered, disposition, reason, businessDisp = null) => {
        let bDisp = raw.intent ? String(raw.intent).toUpperCase() : businessDisp;
        if (!bDisp) {
            if (disposition === "do_not_call") {
                bDisp = "DNC";
            } else if (disposition === "callback_requested") {
                bDisp = "CALLBACK_REQUESTED";
            } else if (disposition === "not_interested") {
                bDisp = "NOT_INTERESTED";
            } else if (disposition === "interested") {
                bDisp = "INTERESTED";
            } else if (disposition === "ring_timeout") {
                bDisp = "NO_ANSWER";
            } else if (disposition === "busy") {
                bDisp = "BUSY";
            } else if (disposition === "failed") {
                bDisp = "FAILED";
            } else if (isAnswered) {
                bDisp = "CONNECTED";
            } else {
                bDisp = "UNANSWERED";
            }
        }
        return {
            technicalStatus,
            status: technicalStatus.toLowerCase(),
            normalizedOutcome,
            isAnswered,
            disposition,
            businessDisposition: bDisp,
            reason,
            durationSeconds: duration,
            billableDurationSeconds: billDuration,
            providerCost,
            hangupCause,
            answeredAt,
            completedAt,
        };
    };

    const isMachine = Boolean(
        raw.machineDetection === "true" ||
        raw.amd_status === "machine" ||
        hangupCause.includes("voicemail") ||
        hangupCause.includes("answering machine")
    );

    if (isMachine) {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.VOICEMAIL, ASE_OUTCOMES.VOICEMAIL, false, "voicemail_detected", "Answering machine detected", "VOICEMAIL");
    }

    if (
        hangupCause.includes("ring timeout") ||
        hangupCause.includes("timeout") ||
        providerStatus === "timeout"
    ) {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.RING_TIMEOUT, ASE_OUTCOMES.RING_TIMEOUT, false, "ring_timeout", "Ring timeout reached", "NO_ANSWER");
    }

    if (
        hangupCause.includes("user_busy") ||
        hangupCause.includes("busy") ||
        providerStatus === "busy"
    ) {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.BUSY, ASE_OUTCOMES.BUSY, false, "busy", "Recipient busy", "BUSY");
    }

    if (
        hangupCause.includes("call_rejected") ||
        hangupCause.includes("rejected") ||
        providerStatus === "rejected"
    ) {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.REJECTED, ASE_OUTCOMES.REJECTED, false, "rejected", "Call rejected by callee or network", "REJECTED");
    }

    if (
        hangupCause.includes("originator_cancel") ||
        providerStatus === "canceled" ||
        providerStatus === "cancelled"
    ) {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.CANCELED, ASE_OUTCOMES.CANCELED, false, "canceled", "Call canceled by caller", "CANCELED");
    }

    if (
        hangupCause.includes("no_answer") ||
        providerStatus === "no-answer" ||
        providerStatus === "no_answer"
    ) {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.NO_ANSWER, ASE_OUTCOMES.NO_ANSWER, false, "no_answer", "No answer from callee", "NO_ANSWER");
    }

    if (providerStatus === "early-media" || providerStatus === "early_media" || hangupCause.includes("early media")) {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.EARLY_MEDIA, ASE_OUTCOMES.NO_ANSWER, false, "early_media", "Early media signal received without connection", raw.intent ? String(raw.intent).toUpperCase() : "EARLY_MEDIA");
    }

    if (providerStatus === "ringing") {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.RINGING, ASE_OUTCOMES.AMBIGUOUS, false, "ringing", "Line ringing", "RINGING");
    }

    if (providerStatus === "queued" || providerStatus === "call-queued") {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.QUEUED, ASE_OUTCOMES.AMBIGUOUS, false, "queued", "Call queued at provider", "QUEUED");
    }

    if (providerStatus === "initiated") {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.INITIATED, ASE_OUTCOMES.AMBIGUOUS, false, "initiated", "Outbound call request accepted", "INITIATED");
    }

    const isConfirmedAnswer = Boolean(
        isExplicitAnswerWebhook ||
        providerStatus === "in-progress" ||
        providerStatus === "answer" ||
        providerStatus === "answered" ||
        (providerStatus === "completed" && (hasAnswerTime || billDuration > 0 || duration > 0))
    );

    if (isConfirmedAnswer) {
        let disposition = "connected";
        let outcome = ASE_OUTCOMES.AMBIGUOUS;

        if (speechResult) {
            if (
                speechResult.includes("do not call") ||
                speechResult.includes("stop calling") ||
                speechResult.includes("remove me") ||
                speechResult.includes("don't call")
            ) {
                outcome = ASE_OUTCOMES.DNC;
                disposition = "do_not_call";
            } else if (
                speechResult.includes("call me back") ||
                speechResult.includes("call tomorrow") ||
                speechResult.includes("call later") ||
                speechResult.includes("bad time") ||
                speechResult.includes("callback")
            ) {
                outcome = ASE_OUTCOMES.CALLBACK;
                disposition = "callback_requested";
            } else if (
                speechResult.includes("not interested") ||
                speechResult.includes("no thank you") ||
                speechResult.includes("not looking")
            ) {
                outcome = ASE_OUTCOMES.NOT_INTERESTED;
                disposition = "not_interested";
            } else if (
                speechResult.includes("interested") ||
                speechResult.includes("sounds good") ||
                speechResult.includes("tell me more") ||
                speechResult.includes("send details")
            ) {
                outcome = ASE_OUTCOMES.INTERESTED;
                disposition = "interested";
            } else {
                disposition = "connected_conversation";
                outcome = ASE_OUTCOMES.AMBIGUOUS;
            }
        }

        const techStatus = providerStatus === "completed"
            ? TELEPHONY_TECHNICAL_STATUS.COMPLETED
            : TELEPHONY_TECHNICAL_STATUS.IN_PROGRESS;

        return buildResult(techStatus, outcome, true, disposition, "Authoritative provider answer confirmed");
    }

    if (providerStatus === "completed" && duration === 0 && billDuration === 0 && !hasAnswerTime) {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.COMPLETED, ASE_OUTCOMES.NO_ANSWER, false, "unanswered_completed", "Provider reported completed with 0s duration and no answer timestamp", "UNANSWERED");
    }

    if (providerStatus === "failed") {
        return buildResult(TELEPHONY_TECHNICAL_STATUS.FAILED, ASE_OUTCOMES.FAILED, false, "failed", raw.message || raw.error || "Provider call failure", "FAILED");
    }

    return buildResult(TELEPHONY_TECHNICAL_STATUS.COMPLETED, ASE_OUTCOMES.AMBIGUOUS, false, "completed_unknown", "Call ended with unspecified disposition", "UNKNOWN");
}

export function normalizeChannelOutcome(channel, rawResponse = {}) {
    if (!rawResponse) return ASE_OUTCOMES.AMBIGUOUS;

    if (channel === "VOICE") {
        const normalized = normalizeTelephonyOutcome(rawResponse);
        return normalized.normalizedOutcome;
    }

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

    return ASE_OUTCOMES.AMBIGUOUS;
}

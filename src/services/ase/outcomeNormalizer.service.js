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

const TECHNICAL_NON_CONNECT_OUTCOMES = new Set([
    ASE_OUTCOMES.NO_ANSWER,
    ASE_OUTCOMES.RING_TIMEOUT,
    ASE_OUTCOMES.BUSY,
    ASE_OUTCOMES.FAILED,
    ASE_OUTCOMES.CANCELED,
    ASE_OUTCOMES.REJECTED,
    ASE_OUTCOMES.VOICEMAIL,
]);

const BOT_PROMPT_RE = /\b(?:would you like|do you (?:want|have)|is now a good time|can i (?:tell|share|schedule|book)|let me (?:tell|share|schedule|walk)|if you(?:'re| are) interested|are you interested|anyone interested)\b[^.?!\n]*/gi;
const SPEAKER_PROSPECT_RE = /(?:^|\n)\s*(?:prospect|customer|callee|user|human|lead)\s*[:\-]\s*(.+)/gi;
const SPEAKER_AGENT_RE = /(?:^|\n)\s*(?:agent|bot|assistant|nova|ai|rep|system)\s*[:\-]\s*.+/gi;

function isolateProspectSpeech(raw = "") {
    const text = String(raw || "");
    const prospectTurns = [];
    const speakerProspect = new RegExp(SPEAKER_PROSPECT_RE.source, "gi");
    let match;
    while ((match = speakerProspect.exec(text))) {
        prospectTurns.push(match[1]);
    }
    if (prospectTurns.length) {
        return prospectTurns.join(" ").replace(/\s+/g, " ").trim();
    }

    return text
        .replace(new RegExp(SPEAKER_AGENT_RE.source, "gi"), " ")
        .replace(new RegExp(BOT_PROMPT_RE.source, "gi"), " ")
        .replace(/\s+/g, " ")
        .trim();
}

function mapExplicitDisposition(value = "") {
    const text = String(value || "").toLowerCase();
    if (!text) return null;
    if (/\b(dnc|do[_ ]?not[_ ]?call|unsubscribe)\b/.test(text)) {
        return { outcome: ASE_OUTCOMES.DNC, disposition: "do_not_call" };
    }
    if (/\b(not[_ ]?interested|unqualified)\b/.test(text)) {
        return { outcome: ASE_OUTCOMES.NOT_INTERESTED, disposition: "not_interested" };
    }
    if (/\b(callback|call[_ ]?back|follow[_ ]?up)\b/.test(text)) {
        return { outcome: ASE_OUTCOMES.CALLBACK, disposition: "callback_requested" };
    }
    if (/\b(interested|qualified|hot)\b/.test(text)) {
        return { outcome: ASE_OUTCOMES.INTERESTED, disposition: "interested" };
    }
    if (/\b(voicemail|machine)\b/.test(text)) {
        return { outcome: ASE_OUTCOMES.VOICEMAIL, disposition: "voicemail_detected" };
    }
    return null;
}

export function extractCallTranscript(raw = {}) {
    const buckets = [raw];
    if (raw && typeof raw === "object") {
        for (const key of ["variables", "data", "result", "payload", "call"]) {
            if (raw[key] && typeof raw[key] === "object") buckets.push(raw[key]);
        }
    }
    for (const obj of buckets) {
        for (const key of ["SpeechResult", "transcript", "conversation", "summary", "Text", "text", "call_transcript", "dialogue"]) {
            const val = obj?.[key];
            if (typeof val === "string" && val.trim()) return val.trim();
            if (Array.isArray(val)) {
                const joined = val
                    .map((turn) => (typeof turn === "string" ? turn : turn?.text || turn?.content || turn?.message || ""))
                    .filter(Boolean)
                    .join(" ");
                if (joined.trim()) return joined.trim();
            }
        }
    }
    return "";
}

export function classifyProspectSpeech(raw = "") {
    const original = String(raw || "").toLowerCase().trim();
    const prospectText = isolateProspectSpeech(raw).toLowerCase();
    const scan = prospectText || original;

    const emptyResult = {
        outcome: ASE_OUTCOMES.AMBIGUOUS,
        disposition: original ? "bot_prompt_only" : "connected_unspecified",
        isDnc: false,
        callbackRequested: false,
        interested: false,
    };

    if (!original) return emptyResult;

    if (
        /\b(do not call|don't call|stop calling|remove me|unsubscribe|do not contact|don't contact|dont contact)\b/.test(scan)
    ) {
        return {
            outcome: ASE_OUTCOMES.DNC,
            disposition: "do_not_call",
            isDnc: true,
            callbackRequested: false,
            interested: false,
        };
    }

    if (/\b(not interested|no thank you|no thanks|not looking)\b/.test(scan)) {
        return {
            outcome: ASE_OUTCOMES.NOT_INTERESTED,
            disposition: "not_interested",
            isDnc: false,
            callbackRequested: false,
            interested: false,
        };
    }

    if (!prospectText) return emptyResult;

    if (
        /\b(call me back|call (me )?(tomorrow|later)|give me a callback|please callback|bad time|not a good time|busy right now)\b/.test(prospectText)
    ) {
        return {
            outcome: ASE_OUTCOMES.CALLBACK,
            disposition: "callback_requested",
            isDnc: false,
            callbackRequested: true,
            interested: false,
        };
    }

    const firstPersonInterest = /\b(i(?:'m| am) interested|we(?:'re| are) interested|sounds good|tell me more|send (?:me )?details|book a (?:call|demo|meeting)|let'?s (?:talk|connect|book|schedule)|yes[, ]+i (?:am|would)|i(?:'d| would) like to (?:schedule|book|set up))\b/;
    const affirmativeMeeting = /\b(yes|yeah|yep|sure|please|i want|let'?s|book|set up|setup)\b[\s\S]{0,60}\b(demo|meeting|schedule)\b/;

    if (firstPersonInterest.test(prospectText) || affirmativeMeeting.test(prospectText)) {
        return {
            outcome: ASE_OUTCOMES.INTERESTED,
            disposition: "interested",
            isDnc: false,
            callbackRequested: false,
            interested: true,
        };
    }

    return {
        outcome: ASE_OUTCOMES.AMBIGUOUS,
        disposition: "unclassified",
        isDnc: false,
        callbackRequested: false,
        interested: false,
    };
}

export function isTechnicalNonConnectOutcome(outcome) {
    return TECHNICAL_NON_CONNECT_OUTCOMES.has(outcome);
}

export function shouldQueueHumanHandoff(outcome, rawData = {}) {
    if (outcome !== ASE_OUTCOMES.INTERESTED && outcome !== ASE_OUTCOMES.CALLBACK) {
        return false;
    }
    if (rawData.isAnswered === false || rawData.answered === false) {
        return false;
    }
    if (isTechnicalNonConnectOutcome(outcome)) {
        return false;
    }
    const status = String(rawData.callStatus || rawData.CallStatus || rawData.status || "").toLowerCase();
    if (["busy", "no-answer", "no_answer", "timeout", "failed", "canceled", "cancelled", "rejected"].includes(status)) {
        return false;
    }
    return true;
}

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

    let providerStatus = String(raw.CallStatus || raw.call_status || raw.Status || raw.status || raw.call_state || "").toLowerCase().trim();
    const hangupCause = String(raw.HangupCause || raw.hangup_cause || raw.hangup_cause_name || raw.disposition || raw.call_disposition || "").toLowerCase().trim();
    const duration = Number(raw.Duration || raw.call_duration || raw.duration_sec || raw.CallDuration || 0);
    const billDuration = Number(raw.BillDuration || raw.billed_duration || raw.billable_duration_sec || 0);
    const hasAnswerTime = Boolean(raw.AnswerTime || raw.answer_time);
    const speechResult = extractCallTranscript(raw).toLowerCase();
    if (!providerStatus && (speechResult || hangupCause || raw.lead_id || raw.leadId)) {
        providerStatus = "completed";
    }
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

    const explicitDisposition = String(raw.disposition || raw.call_disposition || raw.intent || "").toLowerCase().trim();
    const mappedExplicit = mapExplicitDisposition(explicitDisposition);

    const isConfirmedAnswer = Boolean(
        isExplicitAnswerWebhook ||
        providerStatus === "in-progress" ||
        providerStatus === "answer" ||
        providerStatus === "answered" ||
        (providerStatus === "completed" && (hasAnswerTime || billDuration > 0 || duration > 0 || Boolean(speechResult)))
    );

    if (isConfirmedAnswer) {
        let disposition = "connected";
        let outcome = ASE_OUTCOMES.AMBIGUOUS;

        if (speechResult) {
            const classified = classifyProspectSpeech(speechResult);
            outcome = classified.outcome;
            disposition = classified.outcome === ASE_OUTCOMES.AMBIGUOUS
                ? "connected_conversation"
                : classified.disposition;
        }

        if (mappedExplicit && (outcome === ASE_OUTCOMES.AMBIGUOUS || !speechResult)) {
            outcome = mappedExplicit.outcome;
            disposition = mappedExplicit.disposition;
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
        const hasProviderStatus = Boolean(
            rawResponse.CallStatus ||
            rawResponse.call_status ||
            rawResponse.Status ||
            rawResponse.status ||
            rawResponse.call_state ||
            rawResponse.HangupCause ||
            rawResponse.hangup_cause
        );
        if (hasProviderStatus) {
            return normalizeTelephonyOutcome(rawResponse).normalizedOutcome;
        }
    }

    const intent = String(rawResponse.detectedIntent || rawResponse.intent || "").toLowerCase();
    const disposition = String(rawResponse.disposition || rawResponse.status || "").toLowerCase();
    const text = String(rawResponse.transcript || rawResponse.body || rawResponse.reply || "").toLowerCase();
    const subject = String(rawResponse.subject || "").toLowerCase();

    if (
        intent.includes("ooo") ||
        intent.includes("out_of_office") ||
        disposition.includes("ooo") ||
        text.includes("out of office") ||
        text.includes("automatic reply") ||
        text.includes("auto-reply") ||
        text.includes("autoreply") ||
        text.includes("away from my desk") ||
        text.includes("on vacation") ||
        text.includes("annual leave") ||
        text.includes("currently away") ||
        text.includes("i am out of the office") ||
        text.includes("i will be out") ||
        subject.includes("out of office") ||
        subject.includes("automatic reply") ||
        subject.includes("auto-reply")
    ) {
        return ASE_OUTCOMES.OOO;
    }

    if (
        disposition.includes("dnc") ||
        disposition.includes("do_not_call") ||
        disposition.includes("unsubscribe") ||
        intent.includes("dnc") ||
        text.includes("unsubscribe") ||
        text.includes("remove me") ||
        text.includes("stop calling") ||
        text.includes("stop emailing") ||
        text.includes("do not call") ||
        text.includes("do not contact") ||
        text.includes("don't contact") ||
        text.includes("dont contact")
    ) {
        return ASE_OUTCOMES.DNC;
    }

    const classified = classifyProspectSpeech(`${subject} ${text}`.trim());

    if (
        intent.includes("callback") ||
        disposition.includes("callback") ||
        classified.outcome === ASE_OUTCOMES.CALLBACK
    ) {
        return ASE_OUTCOMES.CALLBACK;
    }

    if (
        intent.includes("not_interested") ||
        disposition.includes("not_interested") ||
        classified.outcome === ASE_OUTCOMES.NOT_INTERESTED
    ) {
        return ASE_OUTCOMES.NOT_INTERESTED;
    }

    if (
        intent.includes("interested") ||
        disposition.includes("interested") ||
        classified.outcome === ASE_OUTCOMES.INTERESTED
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

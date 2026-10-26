import { LeadEvent } from "../../../models/lead-event.model.js";
import { query } from "../../../config/db.js";
import { getIo } from "../../../socket/socketServer.js";

function normalizeAction(action) {
    const value = String(action || "WAIT").toUpperCase();
    return value === "NONE" || value === "NULL" || value === "UNDEFINED" ? "WAIT" : value;
}

function normalizeProbabilities(raw) {
    if (!raw || typeof raw !== "object") return null;
    const entries = Object.entries(raw)
        .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0);
    const sum = entries.reduce((acc, [, value]) => acc + value, 0);
    if (sum <= 0) return null;
    return Object.fromEntries(
        entries.map(([key, value]) => [String(key).toUpperCase(), Math.round((value / sum) * 1000) / 1000])
    );
}

function probabilitiesChanged(previous, next) {
    if (!previous && !next) return false;
    if (!previous || !next) return true;
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    for (const key of keys) {
        if (Math.abs(Number(previous[key] || 0) - Number(next[key] || 0)) >= 0.03) {
            return true;
        }
    }
    return false;
}

function emitDecisionUpdate(leadId, orgId, payload) {
    try {
        const io = getIo();
        if (!io) return;
        io.emit("ase:lead_event", {
            eventType: "DECISION_EVALUATED",
            event_type: "DECISION_EVALUATED",
            leadId,
            lead_id: leadId,
            organizationId: orgId,
            organization_id: orgId,
            payload,
            timestamp: payload.timestamp,
        });
    } catch (_) {}
}

export const decisionAuditService = {
    async logDecision({ lead, decision, explanation, prediction, conversionPrediction = null }) {
        try {
            const orgId = Number(lead.organization_id || 1);
            const leadId = Number(lead.id);
            const nextAction = normalizeAction(decision.recommendedAction || decision.action);
            const normalizedProbabilities = normalizeProbabilities(prediction?.probabilities);

            const recent = await query(
                `SELECT id, payload, created_at FROM lead_events 
                 WHERE organization_id = ? AND lead_id = ? AND event_type = 'DECISION_EVALUATED'
                 ORDER BY created_at DESC LIMIT 1`,
                [orgId, leadId]
            );

            if (recent && recent.length > 0) {
                const lastEvent = recent[0];
                const lastPayload = typeof lastEvent.payload === "string"
                    ? JSON.parse(lastEvent.payload || "{}")
                    : (lastEvent.payload || {});
                const elapsedMs = Date.now() - new Date(lastEvent.created_at).getTime();
                const sameAction = normalizeAction(lastPayload.action) === nextAction;
                const sameProbs = !probabilitiesChanged(lastPayload.probabilities, normalizedProbabilities);
                if (sameAction && sameProbs && elapsedMs < 30 * 60 * 1000) {
                    return;
                }
            }

            const confVal = typeof decision.confidence === "number" && Number.isFinite(decision.confidence)
                ? (decision.confidence > 1 ? decision.confidence / 100 : decision.confidence)
                : (normalizedProbabilities?.[nextAction] ?? null);

            const payload = {
                action: nextAction,
                delayHours: decision.delayHours,
                confidence: confVal,
                isAssistedByMl: Boolean(decision.isAssistedByMl),
                reasonCode: decision.reasonCode,
                reasonSummary: explanation.summary,
                reasonCodes: explanation.reasonCodes,
                probabilities: normalizedProbabilities,
                shadowPrediction: decision.shadowPrediction || null,
                modelVersion: prediction?.modelVersion || "rules-only",
                conversionProbability: conversionPrediction?.probability ?? null,
                conversionConfidence: conversionPrediction?.confidence ?? null,
                sendWindow: decision.sendWindow || null,
                emailAttempts: decision.emailAttempts ?? null,
                voiceAttempts: decision.voiceAttempts ?? null,
                timestamp: new Date().toISOString(),
            };

            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: decision.channel || "SYSTEM",
                event_type: "DECISION_EVALUATED",
                status: lead.status || "NEW",
                payload,
            });

            emitDecisionUpdate(leadId, orgId, payload);
        } catch (error) {
            console.error("Decision audit error:", error.message);
        }
    },
};

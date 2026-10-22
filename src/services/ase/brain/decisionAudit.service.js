import { LeadEvent } from "../../../models/lead-event.model.js";
import { query } from "../../../config/db.js";

export const decisionAuditService = {
    async logDecision({ lead, decision, explanation, prediction, conversionPrediction = null }) {
        try {
            const orgId = Number(lead.organization_id || 1);
            const leadId = Number(lead.id);

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
                if (lastPayload.action === decision.recommendedAction && elapsedMs < 30 * 60 * 1000) {
                    return;
                }
            }

            let normalizedProbabilities = null;
            if (prediction?.probabilities && typeof prediction.probabilities === "object") {
                const entries = Object.entries(prediction.probabilities)
                    .filter(([_, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0);
                const sum = entries.reduce((acc, [_, v]) => acc + v, 0);
                if (sum > 0) {
                    normalizedProbabilities = Object.fromEntries(
                        entries.map(([k, v]) => [k, Math.round((v / sum) * 1000) / 1000])
                    );
                }
            }

            const confVal = typeof decision.confidence === "number" && Number.isFinite(decision.confidence)
                ? (decision.confidence > 1 ? decision.confidence / 100 : decision.confidence)
                : null;

            await LeadEvent.create({
                organization_id: orgId,
                lead_id: lead.id,
                channel: decision.channel || "SYSTEM",
                event_type: "DECISION_EVALUATED",
                status: lead.status || "NEW",
                payload: {
                    action: decision.recommendedAction,
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
                    timestamp: new Date().toISOString(),
                },
            });
        } catch (error) {
            console.error("Decision audit error:", error.message);
        }
    },
};

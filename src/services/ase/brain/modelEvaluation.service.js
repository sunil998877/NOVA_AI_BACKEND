import { query } from "../../../config/db.js";
import { modelRegistry } from "./modelRegistry.service.js";

export const modelEvaluationService = {
    async getEvaluationReport(organizationId = 1) {
        const status = modelRegistry.getModelStatus();
        let totalDecisions = 0;
        let shadowDecisions = 0;
        let shadowConcurrences = 0;

        try {
            const rows = await query(`
                SELECT payload FROM lead_events
                WHERE organization_id = ? AND event_type = 'DECISION_EVALUATED'
                ORDER BY id DESC LIMIT 500
            `, [Number(organizationId)]);

            for (const r of rows) {
                totalDecisions++;
                const payload = typeof r.payload === "string" ? JSON.parse(r.payload || "{}") : (r.payload || {});
                if (payload.shadowPrediction) {
                    shadowDecisions++;
                    if (payload.shadowPrediction.concursWithBaseline) {
                        shadowConcurrences++;
                    }
                }
            }
        } catch (e) {
            console.error("Evaluation report error:", e.message);
        }

        const shadowAgreementRate = shadowDecisions > 0
            ? Number(((shadowConcurrences / shadowDecisions) * 100).toFixed(2))
            : null;

        return {
            organizationId: Number(organizationId),
            modelStatus: status,
            totalDecisionsSampled: totalDecisions,
            shadowMode: {
                totalShadowEvaluations: shadowDecisions,
                shadowConcurrences,
                shadowAgreementRate: shadowAgreementRate !== null ? `${shadowAgreementRate}%` : "No shadow events",
            },
            trainingMetrics: {
                modelAccuracy: status.accuracy ? `${(status.accuracy * 100).toFixed(2)}%` : "N/A",
                trainingDatasetSize: status.totalSamples || "N/A",
            },
        };
    },
};

import { LeadEvent } from "../../../models/lead-event.model.js";

export const decisionFeedbackService = {
    async recordOutcome({ organizationId, leadId, channel, outcome, rawPayload = {} }) {
        try {
            await LeadEvent.create({
                organization_id: Number(organizationId || 1),
                lead_id: Number(leadId),
                channel: channel || "SYSTEM",
                event_type: "OUTCOME_RECORDED",
                status: outcome,
                payload: {
                    outcome,
                    rawPayload,
                    recordedAt: new Date().toISOString(),
                },
            });
            return { success: true };
        } catch (error) {
            console.error("Feedback recording error:", error.message);
            return { success: false, error: error.message };
        }
    },
};

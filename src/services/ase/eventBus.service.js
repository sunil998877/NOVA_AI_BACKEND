import { EventEmitter } from "events";
import { LeadEvent } from "../../models/lead-event.model.js";
import { getIo } from "../../socket/socketServer.js";
import { v4 as uuidv4 } from "uuid";

export const ASE_EVENT_TYPES = Object.freeze({
    LEAD_ACCEPTED: "LeadAccepted",
    LEAD_STATE_CHANGED: "LeadStateChanged",
    ACTION_REQUESTED: "ActionRequested",
    ACTION_SCHEDULED: "ActionScheduled",
    ACTION_DISPATCHED: "ActionDispatched",
    ACTION_COMPLETED: "ActionCompleted",
    ACTION_FAILED: "ActionFailed",
    CHANNEL_OUTCOME_RECEIVED: "ChannelOutcomeReceived",
    CALLBACK_CREATED: "CallbackCreated",
    CALLBACK_COMPLETED: "CallbackCompleted",
    LEAD_SUPPRESSED: "LeadSuppressed",
    LEAD_CLOSED: "LeadClosed",
});

class EventBusService extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(50);
    }

    createEnvelope(eventType, options = {}) {
        const {
            organizationId = 1,
            organization_id = 1,
            leadId = null,
            lead_id = null,
            channel = "SYSTEM",
            status = null,
            payload = {},
            correlationId = null,
            correlation_id = null,
            source = null,
            ...extra
        } = options;
        const combinedPayload = { ...extra, ...(typeof payload === "object" && payload ? payload : {}) };
        const eventId = `evt_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
        const resolvedCorrelationId = correlationId || correlation_id || `corr_${uuidv4().replace(/-/g, "").slice(0, 16)}`;
        const timestamp = new Date().toISOString();
        const effectiveOrgId = Number(organizationId || organization_id || 1);
        const effectiveLeadId = leadId ? Number(leadId) : (lead_id ? Number(lead_id) : null);

        return {
            eventId,
            event_id: eventId,
            eventType,
            event_type: eventType,
            version: "1.0",
            organizationId: effectiveOrgId,
            organization_id: effectiveOrgId,
            leadId: effectiveLeadId,
            lead_id: effectiveLeadId,
            channel,
            status,
            source,
            correlationId: resolvedCorrelationId,
            correlation_id: resolvedCorrelationId,
            timestamp,
            payload: combinedPayload,
        };
    }

    async publish(eventType, options = {}) {
        const envelope = this.createEnvelope(eventType, options);

        try {
            if (envelope.lead_id) {
                await LeadEvent.create({
                    organization_id: envelope.organization_id,
                    lead_id: envelope.lead_id,
                    channel: envelope.channel,
                    event_type: eventType,
                    status: envelope.status || undefined,
                    payload: envelope.payload,
                });
            }
        } catch (dbErr) {
            console.error("[EventBus] Failed to persist outbox event:", dbErr.message);
        }

        try {
            const io = getIo();
            if (io) {
                io.emit("ase:lead_event", envelope);
            }
        } catch (_) {}

        this.emit(eventType, envelope);
        this.emit("*", envelope);

        return envelope;
    }

    subscribe(eventType, handler) {
        this.on(eventType, handler);
        return () => this.off(eventType, handler);
    }
}

export const eventBus = new EventBusService();

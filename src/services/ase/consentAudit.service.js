import { ConsentEvent } from "../../models/consent-event.model.js";
import { normalizeConsentSource, normalizeConsentStatus } from "./consent.service.js";

export async function recordConsentEvent({
    organizationId,
    leadId,
    channel,
    status,
    source,
    actorUserId = null,
}) {
    if (!leadId || !channel) return null;
    try {
        return await ConsentEvent.create({
            organization_id: Number(organizationId || 1),
            lead_id: Number(leadId),
            channel,
            status: normalizeConsentStatus(status),
            source: normalizeConsentSource(source),
            actor_user_id: actorUserId,
        });
    } catch (err) {
        console.warn("[ASE] Could not write consent audit:", err.message);
        return null;
    }
}

export async function recordLeadConsentSnapshot(lead, { organizationId, actorUserId = null } = {}) {
    const orgId = Number(organizationId || lead?.organization_id || 1);
    const leadId = lead?.id;
    if (!leadId) return;
    const rows = [
        ["EMAIL", lead.email_consent],
        ["VOICE", lead.voice_consent],
        ["WHATSAPP", lead.whatsapp_consent],
    ];
    for (const [channel, consent] of rows) {
        if (!consent) continue;
        await recordConsentEvent({
            organizationId: orgId,
            leadId,
            channel,
            status: consent.status,
            source: consent.source,
            actorUserId: actorUserId || consent.actor_user_id,
        });
    }
}

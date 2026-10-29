import { asyncHandler } from "../../utils/asyncHandler.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { Callback } from "../../models/callback.model.js";
import { Suppression } from "../../models/suppression.model.js";
import { env } from "../../config/env.js";
import { describeLeadApiKey, publicApiBase, rotateLeadApiKey, maskApiKey } from "../../services/leads/leadApiCredential.service.js";
import { MAX_BATCH } from "../../services/leads/leadIntake.service.js";
import { aseScheduler } from "../../services/ase/scheduler.service.js";
import { OrchestratorService } from "../../services/ase/orchestrator.service.js";
import { query } from "../../config/db.js";
import { draftCompanyPersonalizedEmail } from "../../services/ase/leadEmailDrafter.service.js";
import { isUsableResearchProfile } from "../../services/ase/companyResearch.service.js";
import { enqueueLeadCompanyResearch } from "../../services/leads/companyResearchQueue.js";
import { getLeadApproval } from "../../services/ase/approvalQueue.service.js";
import { executionFlagsForMode, getOperatingMode } from "../../services/ase/operatingMode.service.js";
import { OPERATING_MODES } from "../../services/ase/operatingMode.constants.js";
import { haltOutreachForLead } from "../../services/ase/outreachHalt.service.js";
import { buildConsentRecord, isConsentGranted } from "../../services/ase/consent.service.js";
import { recordConsentEvent } from "../../services/ase/consentAudit.service.js";
import { isTerminalStatus, sanitizeNextAction, sanitizeStatus } from "../../services/ase/lifecycle.service.js";
import { buildNbaCard } from "../../services/ase/nbaCard.service.js";
import { loggedDecisionFromTimeline } from "../../services/ase/nbaPresent.service.js";

const TERMINAL_STATES = new Set(["CLOSED_WON", "CLOSED_LOST", "CLOSED_UNQUALIFIED", "SUPPRESSED_DNC"]);

export const listLeads = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const { items, total } = await Lead.list(orgId, {
        q: String(req.query.q || ""),
        source: String(req.query.source || ""),
        status: String(req.query.status || ""),
        health: String(req.query.health || ""),
        min_priority: req.query.min_priority !== undefined && req.query.min_priority !== "" ? Number(req.query.min_priority) : null,
        email_consent: String(req.query.email_consent || ""),
        do_not_contact: req.query.do_not_contact,
        priority: req.query.priority !== undefined && req.query.priority !== "" ? req.query.priority : null,
        assigned_rep_id: req.query.assigned_rep_id ? Number(req.query.assigned_rep_id) : null,
        skip: (page - 1) * limit,
        limit,
    });

    return res.status(200).json({ data: items, pagination: { page, limit, total } });
});

export const getLead = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const lead = await Lead.findById(req.params.id, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    if (lead.company && !isUsableResearchProfile(lead.metadata?.company_research)) {
        enqueueLeadCompanyResearch(lead);
    }

    const timeline = await LeadEvent.listByLead(orgId, lead.id, 100).catch(() => []);
    const [operatingMode, pendingApproval] = await Promise.all([
        getOperatingMode(orgId).catch(() => OPERATING_MODES.FULLY_AUTOMATED),
        getLeadApproval(orgId, lead.id).catch(() => null),
    ]);
    const nba = await buildNbaCard(
        lead,
        loggedDecisionFromTimeline(timeline) || {
            action: lead.next_action,
            scheduledTime: lead.next_action_time,
        },
        { operatingMode, pendingApproval }
    ).catch(() => null);
    return res.status(200).json({
        data: {
            lead,
            timeline: timeline || [],
            operatingMode,
            pendingApproval,
            nba,
        },
    });
});

export const updateLead = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const lead = await Lead.findById(req.params.id, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const updates = { ...req.body };
    const actorUserId = req.user.id;
    const consentChanges = [];

    if (updates.consentEmail !== undefined || updates.email_consent !== undefined) {
        const next = updates.email_consent && typeof updates.email_consent === "object"
            ? buildConsentRecord({
                status: updates.email_consent.status ?? updates.consentEmail,
                source: updates.email_consent.source || "form",
                actorUserId,
            })
            : buildConsentRecord({ status: updates.consentEmail, source: "form", actorUserId });
        updates.email_consent = next;
        delete updates.consentEmail;
        consentChanges.push(["EMAIL", next]);
    }
    if (updates.consentVoice !== undefined || updates.voice_consent !== undefined) {
        const next = updates.voice_consent && typeof updates.voice_consent === "object"
            ? buildConsentRecord({
                status: updates.voice_consent.status ?? updates.consentVoice,
                source: updates.voice_consent.source || "form",
                actorUserId,
            })
            : buildConsentRecord({ status: updates.consentVoice, source: "form", actorUserId });
        updates.voice_consent = next;
        delete updates.consentVoice;
        consentChanges.push(["VOICE", next]);
    }

    const oldStatus = lead.status;
    if (updates.status) updates.status = sanitizeStatus(updates.status);
    if (Object.prototype.hasOwnProperty.call(updates, "next_action")) {
        updates.next_action = sanitizeNextAction(updates.next_action);
    }
    const newStatus = updates.status;

    if (updates.metadata && typeof updates.metadata === "object") {
        updates.metadata = {
            ...(lead.metadata || {}),
            ...updates.metadata,
        };
    }

    const dncFlag = updates.do_not_contact;
    const markDnc = dncFlag === true || dncFlag === 1 || dncFlag === "1";
    const clearDnc = dncFlag === false || dncFlag === 0 || dncFlag === "0";

    if (markDnc) {
        updates.do_not_contact = 1;
        updates.status = "SUPPRESSED_DNC";
        updates.next_action = null;
        updates.next_action_time = null;
        await Suppression.add(orgId, "EMAIL", lead.email, "Marked DNC via UI");
        if (lead.phone) await Suppression.add(orgId, "PHONE", lead.phone, "Marked DNC via UI");
        await haltOutreachForLead(orgId, lead.id, "Marked DNC via UI");
    } else if (clearDnc) {
        updates.do_not_contact = 0;
        if (!newStatus || newStatus === "SUPPRESSED_DNC") {
            updates.status = "CONTACTED";
        }
        await Suppression.removeByContact(orgId, { email: lead.email, phone: lead.phone });
    } else if (newStatus && (TERMINAL_STATES.has(newStatus) || isTerminalStatus(newStatus))) {
        updates.next_action = null;
        updates.next_action_time = null;
    }

    const updated = await Lead.updateById(lead.id, updates, orgId);

    for (const [channel, consent] of consentChanges) {
        await recordConsentEvent({
            organizationId: orgId,
            leadId: lead.id,
            channel,
            status: consent.status,
            source: consent.source,
            actorUserId,
        });
    }

    if (!markDnc && newStatus && isTerminalStatus(newStatus) && newStatus !== oldStatus) {
        await haltOutreachForLead(orgId, lead.id, `Lead closed (${newStatus})`);
    }

    if (newStatus && newStatus !== oldStatus) {
        await LeadEvent.create({
            organization_id: orgId,
            lead_id: lead.id,
            user_id: req.user.id,
            channel: "SYSTEM",
            event_type: "LEAD_STATE_CHANGED",
            status: newStatus,
            payload: { from: oldStatus, to: newStatus, notes: updates.notes || null },
        });
    }

    if (updates.assigned_rep_id && updates.assigned_rep_id !== lead.assigned_rep_id) {
        await LeadEvent.create({
            organization_id: orgId,
            lead_id: lead.id,
            user_id: req.user.id,
            channel: "SYSTEM",
            event_type: "REP_ASSIGNED",
            payload: { repId: updates.assigned_rep_id },
        });
    }

    return res.status(200).json({ data: updated });
});

export const leadStats = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const byStatus = await Lead.countByStatus(orgId);
    const bySource = await Lead.countBySource(orgId);
    const callbackStats = await Callback.countStats(orgId);
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

    return res.status(200).json({
        data: {
            total,
            byStatus,
            bySource,
            callbacks: callbackStats,
        },
    });
});

export const deleteLead = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const ok = await Lead.deleteById(req.params.id, orgId);
    if (!ok) return res.status(404).json({ error: "Lead not found" });
    return res.status(200).json({ data: { deleted: true } });
});

export const getApiCaptureConfig = asyncHandler(async (req, res) => {
    const credential = await describeLeadApiKey();
    const organizationId = Number(req.user.organization_id || credential.organizationId || 1);
    if (credential.organizationId !== organizationId) {
        return res.status(403).json({ error: "Lead API credentials belong to a different organization" });
    }
    return res.status(200).json({
        data: {
            apiKey: credential.apiKey,
            apiKeyPrefix: credential.apiKeyPrefix,
            apiKeyMasked: credential.apiKeyMasked,
            apiKeyConfigured: credential.apiKeyConfigured,
            keyStoredAsHash: credential.keyStoredAsHash,
            rotatedAt: credential.rotatedAt,
            endpoint: "/api/leads",
            webhookEndpoint: "/api/leads/webhook",
            publicBaseUrl: publicApiBase(req),
            deployedBaseUrl: env.publicApiUrl || null,
            organizationId,
            maxBatch: MAX_BATCH,
            authHeader: "x-api-key",
            devProxy: "The Vite dev server proxies /api to the backend. External webhook senders must use publicBaseUrl.",
        },
    });
});

export const rotateApiCaptureKey = asyncHandler(async (req, res) => {
    const credential = await describeLeadApiKey();
    const organizationId = Number(req.user.organization_id || 0);
    if (!organizationId || credential.organizationId !== organizationId) {
        return res.status(403).json({ error: "Only the API key organization can rotate this key" });
    }
    const rotated = await rotateLeadApiKey();
    return res.status(200).json({
        data: {
            apiKey: rotated.apiKey,
            apiKeyPrefix: rotated.apiKeyPrefix,
            apiKeyMasked: rotated.apiKeyMasked || maskApiKey(rotated.apiKey),
            rotatedAt: rotated.rotatedAt,
            organizationId: rotated.organizationId,
        },
    });
});

export const executeLeadAction = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    let lead = await Lead.findById(req.params.id, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });
    if (lead.do_not_contact) return res.status(400).json({ error: "Lead is suppressed (Do Not Contact)" });
    if (lead?.metadata?.outreach_hold?.held) {
        return res.status(400).json({ error: "Lead outreach is on hold. Click Unhold first." });
    }
    if (TERMINAL_STATES.has(lead.status)) return res.status(400).json({ error: "Lead is in a terminal state" });

    const startedAt = Date.now();
    if (lead.next_action === "REP_CALLBACK") {
        return res.status(400).json({
            error: "This lead is waiting on a human callback",
            data: { lead, executed: false },
        });
    }

    const validActions = new Set(["EMAIL", "CALL"]);
    let action = validActions.has(lead.next_action) ? lead.next_action : null;

    if (!action) {
        const decision = await OrchestratorService.evaluateNextAction(lead);
        action = decision?.action && validActions.has(decision.action) ? decision.action : null;
        if (!action) {
            const counters = typeof lead.attempt_counters === "string"
                ? JSON.parse(lead.attempt_counters || "{}")
                : (lead.attempt_counters || { email: 0, voice: 0, total: 0 });
            if (lead.email && counters.email < 3 && isConsentGranted(lead.email_consent)) {
                action = "EMAIL";
            } else if (lead.phone && counters.voice < 2 && isConsentGranted(lead.voice_consent)) {
                action = "CALL";
            }
        }
        if (!action) {
            return res.status(400).json({ error: "No eligible action to execute" });
        }
    }

    const mode = await getOperatingMode(orgId);
    if (mode === OPERATING_MODES.AI_RECOMMENDED) {
        return res.status(400).json({
            error: "AI-Recommended mode requires Approve & send. This will not send on its own.",
            data: { lead, executed: false, operatingMode: mode },
        });
    }

    lead = await Lead.updateById(lead.id, {
        next_action: action,
        next_action_time: new Date(),
    }, orgId);

    const flags = executionFlagsForMode(mode, { humanInitiated: true });
    const result = await aseScheduler.processLeadAction(lead, flags);
    const updated = await Lead.findById(lead.id, orgId);
    const elapsedMs = Date.now() - startedAt;

    if (!result?.executed) {
        return res.status(400).json({
            error: result?.reason || "Execution did not complete",
            data: { lead: updated, executed: false, elapsedMs },
        });
    }

    console.log(`[ASE] Execute Now completed for lead ${lead.id} action=${result.action} in ${elapsedMs}ms`);
    return res.status(200).json({
        data: { lead: updated, executed: true, action: result.action, elapsedMs },
    });
});

export const listTeamReps = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const rows = await query(
        `SELECT id, fullName, email, role
         FROM users
         WHERE organization_id = ?
         ORDER BY (role = 'SALESPERSON' OR role = 'SALES_MANAGER') DESC, fullName ASC`,
        [orgId]
    );
    return res.status(200).json({ data: rows });
});

export const draftLeadEmail = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const lead = await Lead.findById(req.params.id, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const drafted = await draftCompanyPersonalizedEmail(lead, req.body || {});
    const existing = lead.metadata || {};
    const metadata = {
        ...existing,
        company_research: existing.company_research || drafted.research,
        outreach_status: "ready",
        outreach_email: {
            subject: drafted.subject,
            text: drafted.text,
            html: drafted.html,
            written_at: new Date().toISOString(),
        },
    };

    const updated = await Lead.updateById(lead.id, { metadata }, orgId);

    await LeadEvent.create({
        organization_id: orgId,
        lead_id: lead.id,
        user_id: req.user.id || null,
        channel: "EMAIL",
        event_type: "EMAIL_DRAFTED",
        status: "COMPLETED",
        payload: {
            subject: drafted.subject,
            company: drafted.research?.company || lead.company,
        },
    });

    return res.status(200).json({ data: { lead: updated, email: metadata.outreach_email } });
});


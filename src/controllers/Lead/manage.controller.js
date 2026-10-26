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

const TERMINAL_STATES = new Set(["CLOSED_WON", "CLOSED_LOST", "CLOSED_UNQUALIFIED", "SUPPRESSED_DNC"]);

export const listLeads = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

    const { items, total } = await Lead.list(orgId, {
        q: String(req.query.q || ""),
        source: String(req.query.source || ""),
        status: String(req.query.status || ""),
        priority: req.query.priority !== undefined ? req.query.priority : null,
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
    return res.status(200).json({
        data: {
            lead,
            timeline: timeline || [],
            operatingMode,
            pendingApproval,
        },
    });
});

export const updateLead = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);
    const lead = await Lead.findById(req.params.id, orgId);
    if (!lead) return res.status(404).json({ error: "Lead not found" });

    const updates = { ...req.body };
    const oldStatus = lead.status;
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
    } else if (clearDnc) {
        updates.do_not_contact = 0;
        if (!newStatus || newStatus === "SUPPRESSED_DNC") {
            updates.status = "CONTACTED";
        }
        await Suppression.removeByContact(orgId, { email: lead.email, phone: lead.phone });
    } else if (newStatus && TERMINAL_STATES.has(newStatus)) {
        updates.next_action = null;
        updates.next_action_time = null;
    }

    const updated = await Lead.updateById(lead.id, updates, orgId);

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

function pct(num, den) {
    const n = Number(num || 0);
    const d = Number(den || 0);
    if (!d) return 0;
    return Math.round((n / d) * 1000) / 10;
}

export const getAseReports = asyncHandler(async (req, res) => {
    const orgId = Number(req.user.organization_id || 1);

    const [speedRows, eventRows, callRows, slaRows] = await Promise.all([
        query(
            `SELECT AVG(TIMESTAMPDIFF(MINUTE, created_at, last_contacted_at)) AS avg_minutes,
                    COUNT(*) AS contacted_count
             FROM leads
             WHERE organization_id = ? AND last_contacted_at IS NOT NULL`,
            [orgId]
        ),
        query(
            `SELECT event_type, channel, COUNT(*) AS c
             FROM lead_events
             WHERE organization_id = ?
             GROUP BY event_type, channel`,
            [orgId]
        ),
        query(
            `SELECT COUNT(*) AS dials,
                    SUM(CASE WHEN is_answered = 1 THEN 1 ELSE 0 END) AS connected
             FROM calls
             WHERE organization_id = ?`,
            [orgId]
        ),
        query(
            `SELECT
                SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status = 'COMPLETED' AND sla_status = 'MET' THEN 1 ELSE 0 END) AS met,
                COUNT(*) AS total
             FROM callbacks
             WHERE organization_id = ?`,
            [orgId]
        ),
    ]);

    const eventCount = (type, channel = null) => (eventRows || [])
        .filter((row) => row.event_type === type && (channel == null || row.channel === channel))
        .reduce((sum, row) => sum + Number(row.c || 0), 0);

    const sent = eventCount("EMAIL_SENT") + eventCount("ActionDispatched", "EMAIL");
    const opened = eventCount("EMAIL_OPENED");
    const replied = eventCount("EMAIL_REPLY_RECEIVED");
    const callbacksQueued = eventCount("CallbackCreated") + eventCount("CALLBACK_CREATED");

    const dials = Number(callRows?.[0]?.dials || 0);
    const connected = Number(callRows?.[0]?.connected || 0);
    const completedCallbacks = Number(slaRows?.[0]?.completed || 0);
    const metCallbacks = Number(slaRows?.[0]?.met || 0);
    const avgMinutesRaw = speedRows?.[0]?.avg_minutes;
    const avgMinutes = avgMinutesRaw == null ? null : Math.round(Number(avgMinutesRaw) * 10) / 10;

    return res.status(200).json({
        data: {
            speedToLeadMinutes: avgMinutes,
            contactedCount: Number(speedRows?.[0]?.contacted_count || 0),
            email: {
                sent,
                opened,
                replied,
                responseRate: pct(opened + replied, sent),
            },
            voice: {
                dials,
                connected,
                callbacks: callbacksQueued,
                connectRate: pct(connected, dials),
            },
            callbacks: {
                total: Number(slaRows?.[0]?.total || 0),
                completed: completedCallbacks,
                met: metCallbacks,
                slaRate: pct(metCallbacks, completedCallbacks),
            },
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
    if (TERMINAL_STATES.has(lead.status)) return res.status(400).json({ error: "Lead is in a terminal state" });

    const startedAt = Date.now();
    if (lead.next_action === "WAIT" || lead.next_action === "REP_CALLBACK") {
        return res.status(400).json({
            error: lead.next_action === "REP_CALLBACK"
                ? "This lead is waiting on a human callback"
                : "The recommended action is to wait",
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
            if (lead.email && counters.email < 3 && lead.email_consent?.status !== "DENIED") {
                action = "EMAIL";
            } else if (lead.phone && counters.voice < 2 && lead.voice_consent?.status !== "DENIED") {
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


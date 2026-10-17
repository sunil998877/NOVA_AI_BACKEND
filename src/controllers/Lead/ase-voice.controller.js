import { plivoVoiceAdapter } from "../../services/ase/adapters/plivoVoice.adapter.js";
import { OrchestratorService } from "../../services/ase/orchestrator.service.js";
import { Lead } from "../../models/lead.model.js";
import { aseScheduler } from "../../services/ase/scheduler.service.js";
import { eventBus } from "../../services/ase/eventBus.service.js";
import { query } from "../../config/db.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const handlePlivoAnswer = asyncHandler(async (req, res) => {
    const leadName = req.query.leadName || req.body?.leadName || "there";
    const customMessage = req.body?.message || req.query.message;

    const xml = plivoVoiceAdapter.generateAnswerXml({
        message: customMessage,
        leadName,
    });

    res.set("Content-Type", "application/xml");
    return res.status(200).send(xml);
});

export const handlePlivoStatus = asyncHandler(async (req, res) => {
    const payload = req.body || {};
    const callStatus = payload.CallStatus || payload.Status || "unknown";
    const callUuid = payload.CallUUID || payload.CallId || payload.request_uuid;
    const transcript = payload.SpeechResult || payload.transcript || payload.Text || "";
    const leadId = req.query.leadId || payload.lead_id || payload.leadId;
    const orgId = Number(req.query.orgId || payload.organization_id || 1);

    const extracted = plivoVoiceAdapter.extractConversationOutcome(transcript);

    if (leadId) {
        const lead = await Lead.findById(leadId, orgId);
        if (lead) {
            await OrchestratorService.handleOutcomeEvent(lead, extracted.outcome, {
                channel: "VOICE",
                provider: "plivo",
                callStatus,
                callUuid,
                transcript,
                disposition: extracted.disposition,
                rawPayload: payload,
            });
        }
    }

    return res.status(200).json({
        status: "received",
        callStatus,
        outcome: extracted.outcome,
        disposition: extracted.disposition,
    });
});

export const dispatchVoiceCall = asyncHandler(async (req, res) => {
    const { leadId, prompt, from } = req.body || {};
    const orgId = Number(req.user?.organization_id || 1);

    if (!leadId) {
        return res.status(400).json({ error: "leadId is required" });
    }

    const lead = await Lead.findById(leadId, orgId);
    if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
    }

    if (!lead.phone) {
        return res.status(400).json({ error: "Lead has no phone number configured" });
    }

    const result = await plivoVoiceAdapter.execute(lead, "CALL", {
        prompt,
        from,
        requireRealProvider: Boolean(req.body.requireRealProvider),
    });

    return res.status(result.status === "SUCCEEDED" ? 200 : 400).json({ data: result });
});

export const getVoiceConfig = asyncHandler(async (req, res) => {
    const isConfigured = plivoVoiceAdapter.isConfigured();
    const missing = plivoVoiceAdapter.getMissingConfiguration();

    return res.status(200).json({
        data: {
            provider: "plivo",
            configured: isConfigured,
            missingFields: missing,
            hasFromNumber: Boolean(process.env.PLIVO_PHONE_NUMBER),
        },
    });
});

export const simulateVoiceOutcome = asyncHandler(async (req, res) => {
    const { leadId, outcome, transcript } = req.body || {};
    const orgId = Number(req.user?.organization_id || 1);

    if (!leadId) {
        return res.status(400).json({ error: "leadId is required" });
    }

    const lead = await Lead.findById(leadId, orgId);
    if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
    }

    const effectiveOutcome = outcome || plivoVoiceAdapter.extractConversationOutcome(transcript).outcome;

    await OrchestratorService.handleOutcomeEvent(lead, effectiveOutcome, {
        channel: "VOICE",
        simulated: true,
        transcript: transcript || "",
    });

    const updatedLead = await Lead.findById(leadId, orgId);
    return res.status(200).json({
        data: {
            lead: updatedLead,
            outcome: effectiveOutcome,
        },
    });
});

const normalizePhone = (num) => {
    if (!num) return "";
    return String(num).replace(/\D/g, "").slice(-10);
};

export const getCallHistory = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const authId = process.env.PLIVO_AUTH_ID || process.env.PLIVO_AGENT_AUTH_ID;
    const authToken = process.env.PLIVO_AUTH_TOKEN || process.env.PLIVO_AGENT_AUTH_TOKEN;

    let rawPlivoCalls = [];
    let plivoAccount = null;

    if (authId && authToken) {
        try {
            const basicAuth = Buffer.from(`${authId}:${authToken}`).toString("base64");
            const [cdrRes, accRes] = await Promise.allSettled([
                fetch(`https://api.plivo.com/v1/Account/${authId}/Call/?limit=60`, {
                    headers: { Authorization: `Basic ${basicAuth}` },
                    signal: AbortSignal.timeout(6000),
                }),
                fetch(`https://api.plivo.com/v1/Account/${authId}/`, {
                    headers: { Authorization: `Basic ${basicAuth}` },
                    signal: AbortSignal.timeout(6000),
                }),
            ]);

            if (cdrRes.status === "fulfilled" && cdrRes.value.ok) {
                const cdrData = await cdrRes.value.json();
                rawPlivoCalls = cdrData.objects || [];
            }
            if (accRes.status === "fulfilled" && accRes.value.ok) {
                plivoAccount = await accRes.value.json();
            }
        } catch (fetchErr) {
            console.warn("Error fetching Plivo CDR:", fetchErr.message);
        }
    }

    const allOrgLeads = await query(
        `SELECT id, name, email, phone, company, status, priority
         FROM leads
         WHERE organization_id = ?`,
        [orgId]
    );

    const leadsByPhone = new Map();
    const leadsById = new Map();
    for (const l of (allOrgLeads || [])) {
        leadsById.set(Number(l.id), l);
        const norm = normalizePhone(l.phone);
        if (norm) {
            leadsByPhone.set(norm, l);
        }
    }

    const leadEvents = await query(
        `SELECT le.id, le.lead_id, le.event_type, le.channel, le.status, le.payload, le.created_at,
                l.name as lead_name, l.email as lead_email, l.phone as lead_phone, l.company as lead_company, l.priority as lead_priority
         FROM lead_events le
         LEFT JOIN leads l ON le.lead_id = l.id
         WHERE le.organization_id = ?
           AND (le.channel = 'VOICE' OR le.event_type IN ('ActionDispatched', 'ActionCompleted', 'ActionFailed', 'ChannelOutcomeReceived', 'CallbackCreated'))
         ORDER BY le.created_at DESC
         LIMIT 100`,
        [orgId]
    );

    const parsedLeadCalls = (leadEvents || []).map((row) => {
        let p = row.payload;
        if (typeof p === "string") {
            try { p = JSON.parse(p); } catch { p = {}; }
        }
        return { ...row, payload: p };
    }).filter(row => row.channel === "VOICE" || row.payload?.channel === "VOICE" || row.event_type.toLowerCase().includes("call"));

    const plivoCallTimes = new Set();
    const plivoCallUuids = new Set();

    const enrichedPlivoCalls = rawPlivoCalls.map((pc) => {
        const toNorm = normalizePhone(pc.to_number);
        const fromNorm = normalizePhone(pc.from_number);
        const matchedLead = leadsByPhone.get(toNorm) || leadsByPhone.get(fromNorm);

        if (pc.call_uuid) {
            plivoCallUuids.add(pc.call_uuid);
        }
        const callTimeMs = pc.initiation_time ? new Date(pc.initiation_time).getTime() : 0;
        if (toNorm && callTimeMs) {
            plivoCallTimes.add(`${toNorm}_${Math.floor(callTimeMs / 180000)}`);
        }

        const relatedEvent = parsedLeadCalls.find((evt) => {
            if (evt.payload?.callId && evt.payload.callId === pc.call_uuid) return true;
            if (matchedLead && evt.lead_id === matchedLead.id) {
                const evtTime = new Date(evt.created_at).getTime();
                return Math.abs(evtTime - callTimeMs) < 180000;
            }
            return false;
        });

        const isAutonomous = relatedEvent ? !relatedEvent.payload?.manual : false;

        return {
            ...pc,
            lead_id: matchedLead ? matchedLead.id : (relatedEvent?.lead_id || null),
            lead_name: matchedLead ? matchedLead.name : (relatedEvent?.lead_name || null),
            lead_company: matchedLead ? matchedLead.company : (relatedEvent?.lead_company || null),
            lead_email: matchedLead ? matchedLead.email : (relatedEvent?.lead_email || null),
            lead_status: matchedLead ? matchedLead.status : null,
            lead_priority: matchedLead ? matchedLead.priority : null,
            is_autonomous: isAutonomous,
            event_id: relatedEvent?.id || null,
        };
    });

    const deduplicatedLeadCalls = parsedLeadCalls.filter((lc) => {
        if (lc.payload?.callId && plivoCallUuids.has(lc.payload.callId)) {
            return false;
        }
        const norm = normalizePhone(lc.lead_phone || lc.payload?.phone);
        const t = lc.created_at ? new Date(lc.created_at).getTime() : 0;
        if (norm && t) {
            const key = `${norm}_${Math.floor(t / 180000)}`;
            if (plivoCallTimes.has(key)) {
                return false;
            }
        }
        return true;
    });

    const scheduledCalls = await query(
        `SELECT id, name, email, phone, company, status, priority, next_action, next_action_time, attempt_counters, health
         FROM leads
         WHERE organization_id = ?
           AND next_action = 'CALL'
           AND do_not_contact = 0
         ORDER BY next_action_time ASC
         LIMIT 50`,
        [orgId]
    );

    const totalPlivoCalls = enrichedPlivoCalls.length;
    const answeredPlivo = enrichedPlivoCalls.filter(c => c.call_state === "ANSWER").length;
    const totalDurationSec = enrichedPlivoCalls.reduce((acc, c) => acc + (Number(c.call_duration) || 0), 0);
    const totalCost = enrichedPlivoCalls.reduce((acc, c) => acc + (Number(c.total_amount) || 0), 0);

    return res.status(200).json({
        data: {
            plivoCalls: enrichedPlivoCalls,
            leadCalls: deduplicatedLeadCalls,
            scheduledCalls: (scheduledCalls || []).map(l => {
                let counters = l.attempt_counters;
                if (typeof counters === "string") {
                    try { counters = JSON.parse(counters); } catch { counters = {}; }
                }
                return { ...l, attempt_counters: counters };
            }),
            stats: {
                totalCalls: totalPlivoCalls,
                answeredCalls: answeredPlivo,
                answerRate: totalPlivoCalls > 0 ? Math.round((answeredPlivo / totalPlivoCalls) * 100) : 0,
                totalMinutes: Math.round(totalDurationSec / 60),
                totalSeconds: totalDurationSec,
                totalCost: Number(totalCost.toFixed(4)),
                balance: plivoAccount?.cash_credits || "12.77",
                fromNumber: process.env.PLIVO_PHONE_NUMBER || "+918035087884",
                provider: "plivo",
                configured: plivoVoiceAdapter.isConfigured(),
            },
        },
    });
});

export const makeDirectCall = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const { leadId, phone, name, message, from } = req.body || {};

    let targetLead = null;
    let targetPhone = phone;
    let targetName = name || "Prospect";

    if (leadId) {
        targetLead = await Lead.findById(leadId, orgId);
        if (!targetLead) {
            return res.status(404).json({ error: "Lead not found" });
        }
        if (targetLead.do_not_contact) {
            return res.status(400).json({ error: "Lead is flagged as Do Not Contact (DNC)" });
        }
        targetPhone = targetLead.phone;
        targetName = targetLead.name || targetName;
    } else if (targetPhone) {
        const norm = normalizePhone(targetPhone);
        if (norm) {
            const matchedRows = await query(
                `SELECT id, name, email, phone, company, status, priority, attempt_counters, do_not_contact
                 FROM leads
                 WHERE organization_id = ? AND (phone = ? OR phone LIKE ?)
                 LIMIT 1`,
                [orgId, targetPhone, `%${norm}`]
            );
            if (matchedRows && matchedRows.length > 0) {
                targetLead = matchedRows[0];
                if (targetLead.do_not_contact) {
                    return res.status(400).json({ error: "Lead is flagged as Do Not Contact (DNC)" });
                }
                targetName = targetLead.name || targetName;
            }
        }
    }

    if (!targetPhone) {
        return res.status(400).json({ error: "A valid phone number is required to make a call" });
    }

    const leadObject = targetLead || {
        id: null,
        name: targetName,
        phone: targetPhone,
        organization_id: orgId,
    };

    const result = await plivoVoiceAdapter.execute(leadObject, "CALL", {
        prompt: message,
        from,
        requireRealProvider: true,
    });

    if (result.status === "SUCCEEDED") {
        if (targetLead) {
            const counters = typeof targetLead.attempt_counters === "string"
                ? JSON.parse(targetLead.attempt_counters || "{}")
                : (targetLead.attempt_counters || { email: 0, voice: 0, total: 0 });
            counters.voice = (counters.voice || 0) + 1;
            counters.total = (counters.total || 0) + 1;

            await Lead.updateById(
                targetLead.id,
                {
                    attempt_counters: counters,
                    last_contacted_at: new Date(),
                    status: targetLead.status === "NEW" ? "CONTACTED" : targetLead.status,
                },
                orgId
            );

            await eventBus.publish("ActionDispatched", {
                organization_id: orgId,
                lead_id: targetLead.id,
                channel: "VOICE",
                action: "CALL",
                payload: {
                    manual: true,
                    phone: targetPhone,
                    provider: "plivo",
                    callId: result.metadata?.providerCallId || result.metadata?.callId,
                    prompt: message,
                },
            });
        }
    }

    return res.status(result.status === "SUCCEEDED" ? 200 : 400).json({ data: result });
});

export const triggerAutonomousCall = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const { leadId } = req.body || {};

    if (!leadId) {
        return res.status(400).json({ error: "leadId is required" });
    }

    let lead = await Lead.findById(leadId, orgId);
    if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
    }
    if (lead.do_not_contact) {
        return res.status(400).json({ error: "Lead is suppressed (DNC)" });
    }
    if (!lead.phone) {
        return res.status(400).json({ error: "Lead has no phone number" });
    }

    lead = await Lead.updateById(
        lead.id,
        {
            next_action: "CALL",
            next_action_time: new Date(),
            status: "DISPATCH_CALL",
        },
        orgId
    );

    await aseScheduler.processLeadAction(lead);
    const updated = await Lead.findById(lead.id, orgId);

    return res.status(200).json({
        data: {
            lead: updated,
            executed: true,
            action: "CALL",
        },
    });
});

export const queueAutonomousCall = asyncHandler(async (req, res) => {
    const orgId = Number(req.user?.organization_id || 1);
    const { leadId, delayMinutes = 0 } = req.body || {};

    if (!leadId) {
        return res.status(400).json({ error: "leadId is required" });
    }

    const lead = await Lead.findById(leadId, orgId);
    if (!lead) {
        return res.status(404).json({ error: "Lead not found" });
    }
    if (lead.do_not_contact) {
        return res.status(400).json({ error: "Lead is suppressed (DNC)" });
    }

    const scheduledTime = new Date(Date.now() + Math.max(0, Number(delayMinutes)) * 60 * 1000);
    const updated = await Lead.updateById(
        lead.id,
        {
            status: "QUEUED",
            next_action: "CALL",
            next_action_time: scheduledTime,
        },
        orgId
    );

    if (Number(delayMinutes) <= 0) {
        aseScheduler.kick();
    }

    return res.status(200).json({ data: { lead: updated, scheduledTime } });
});

export const runSchedulerCycle = asyncHandler(async (_req, res) => {
    aseScheduler.kick();
    return res.status(200).json({
        data: {
            message: "Autonomous outreach cycle kicked successfully",
            timestamp: new Date().toISOString(),
        },
    });
});

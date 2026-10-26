import { Call } from "../../models/call.model.js";
import { plivoVoiceAdapter } from "./adapters/plivoVoice.adapter.js";
import { applyPlivoCallPayload } from "./voiceOutcomeApply.service.js";

const POLL_DELAYS_MS = [8000, 20000, 45000, 90000, 150000];

export function isPollableUuid(uuid) {
    const value = String(uuid || "").trim();
    if (!value) return false;
    if (/^(plivo_sim_|sim_|mock-uuid|uuid-order-|agentflow_\d)/i.test(value)) return false;
    return true;
}

export function mapPlivoCdrToStatusPayload(cdr = {}, extra = {}) {
    const hangup = String(cdr.hangup_cause || cdr.hangup_cause_name || cdr.HangupCause || "").toUpperCase();
    const callState = String(cdr.call_state || cdr.call_status || cdr.status || "").toLowerCase();
    let callStatus = "initiated";

    if (hangup || cdr.end_time) {
        if (hangup.includes("BUSY")) callStatus = "busy";
        else if (hangup.includes("NO_ANSWER") || hangup.includes("NOANSWER")) callStatus = "no-answer";
        else if (hangup.includes("CANCEL")) callStatus = "canceled";
        else if (hangup.includes("REJECT")) callStatus = "rejected";
        else if (hangup.includes("TIMEOUT") || hangup.includes("ALLOTTED_TIMEOUT")) callStatus = "timeout";
        else if (hangup.includes("FAILED") || hangup.includes("UNALLOCATED")) callStatus = "failed";
        else callStatus = "completed";
    } else if (callState.includes("answer") || callState === "in-progress") {
        callStatus = "in-progress";
    } else if (callState.includes("ring")) {
        callStatus = "ringing";
    }

    return {
        CallUUID: cdr.call_uuid || cdr.request_uuid || extra.providerCallUuid,
        CallStatus: callStatus,
        Duration: Number(cdr.call_duration || cdr.duration || 0),
        BillDuration: Number(cdr.bill_duration || cdr.billed_duration || 0),
        HangupCause: cdr.hangup_cause_name || cdr.hangup_cause || null,
        AnswerTime: cdr.answer_time || null,
        EndTime: cdr.end_time || null,
        TotalAmount: cdr.total_amount != null ? cdr.total_amount : null,
        To: cdr.to || cdr.to_number || extra.to,
        From: cdr.from || cdr.from_number || extra.from,
        leadId: extra.leadId,
        orgId: extra.orgId,
        callId: extra.callId,
        source: "plivo_poll",
    };
}

function last10(phone) {
    return String(phone || "").replace(/\D/g, "").slice(-10);
}

async function resolveCdr({ providerCallUuid, phone, createdAt, callId }) {
    if (isPollableUuid(providerCallUuid)) {
        const byUuid = await plivoVoiceAdapter.fetchCallDetails(providerCallUuid);
        if (byUuid?.call_uuid || byUuid?.hangup_cause || byUuid?.hangup_cause_name || byUuid?.end_time) {
            return byUuid;
        }
    }

    const recent = await plivoVoiceAdapter.listRecentCalls({ limit: 25 });
    const needle = last10(phone);
    if (!needle) return null;

    const unused = [];
    for (const row of recent || []) {
        const toMatch = last10(row.to || row.to_number);
        if (toMatch !== needle) continue;
        const uuid = row.call_uuid;
        if (!uuid) continue;
        const already = await Call.findByProviderUuidAnyOrg(uuid);
        if (already && Number(already.id) !== Number(callId)) continue;
        unused.push(row);
    }
    unused.sort((a, b) => new Date(b.initiation_time || 0) - new Date(a.initiation_time || 0));
    return unused[0] || null;
}

export async function syncPlivoCall(call) {
    if (!call?.id) return null;
    if (call.completed_at) return { skipped: true, reason: "already_completed" };

    const cdr = await resolveCdr({
        providerCallUuid: call.provider_call_uuid,
        phone: call.phone_number || call.lead_phone,
        createdAt: call.created_at,
        callId: call.id,
    });
    if (!cdr) {
        console.log(`[ASE][Plivo] No CDR yet for call=${call.id} uuid=${call.provider_call_uuid || "-"} phone=${call.phone_number || "-"}`);
        return { skipped: true, reason: "no_plivo_cdr" };
    }

    const payload = mapPlivoCdrToStatusPayload(cdr, {
        providerCallUuid: cdr.call_uuid || call.provider_call_uuid,
        to: call.phone_number,
        from: call.from_number,
        leadId: call.lead_id,
        orgId: call.organization_id,
        callId: call.id,
    });

    const applied = await applyPlivoCallPayload(payload);
    if (applied?.status === "received") {
        console.log(`[ASE][Plivo] Polled uuid=${payload.CallUUID} status=${payload.CallStatus} duration=${payload.Duration}s call=${call.id}`);
    }
    return applied;
}

export function schedulePlivoCallSync(call) {
    if (typeof process.env.NODE_TEST_CONTEXT !== "undefined") return;
    if (!call?.id) return;
    for (const delay of POLL_DELAYS_MS) {
        const timer = setTimeout(() => {
            syncPlivoCall(call).catch((err) => {
                console.warn(`[ASE][Plivo] Poll failed for call ${call.id}:`, err.message);
            });
        }, delay);
        if (typeof timer.unref === "function") timer.unref();
    }
}

export async function pollOpenPlivoCalls() {
    if (typeof process.env.NODE_TEST_CONTEXT !== "undefined") return { polled: 0 };
    const open = await Call.findOpenForPoll({ olderThanSec: 8, newerThanHours: 8, limit: 20 });
    if (!open.length) return { polled: 0 };
    let polled = 0;
    for (const call of open) {
        try {
            await syncPlivoCall(call);
            polled += 1;
        } catch (err) {
            console.warn(`[ASE][Plivo] Open-call poll failed ${call.id}:`, err.message);
        }
    }
    return { polled };
}

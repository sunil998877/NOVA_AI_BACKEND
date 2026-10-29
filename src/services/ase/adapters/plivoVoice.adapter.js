import { BaseChannelAdapter } from "./base.adapter.js";
import { classifyProspectSpeech } from "../outcomeNormalizer.service.js";
import { env } from "../../../config/env.js";
import { tryPlaybookVoice } from "../salesPlaybook.service.js";
import { resolvePublicBaseUrl } from "../../../utils/publicBaseUrl.js";

export class PlivoVoiceAdapter extends BaseChannelAdapter {
    constructor() {
        super("VOICE");
    }

    isConfigured() {
        const authId = process.env.PLIVO_AUTH_ID || process.env.PLIVO_AGENT_AUTH_ID;
        const authToken = process.env.PLIVO_AUTH_TOKEN || process.env.PLIVO_AGENT_AUTH_TOKEN;
        const fromNumber = process.env.PLIVO_PHONE_NUMBER;
        return Boolean(authId && authToken && fromNumber);
    }

    getAccountAuth() {
        const authId = process.env.PLIVO_AUTH_ID || process.env.PLIVO_AGENT_AUTH_ID;
        const authToken = process.env.PLIVO_AUTH_TOKEN || process.env.PLIVO_AGENT_AUTH_TOKEN;
        if (!authId || !authToken) return null;
        return {
            authId,
            header: `Basic ${Buffer.from(`${authId}:${authToken}`).toString("base64")}`,
        };
    }

    async fetchCallDetails(callUuid) {
        const auth = this.getAccountAuth();
        if (!auth || !callUuid) return null;
        const url = `https://api.plivo.com/v1/Account/${auth.authId}/Call/${encodeURIComponent(callUuid)}/`;
        const response = await fetch(url, {
            headers: { Authorization: auth.header },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return null;
        return response.json().catch(() => null);
    }

    async listRecentCalls({ to, limit = 20 } = {}) {
        const auth = this.getAccountAuth();
        if (!auth) return [];
        const qs = new URLSearchParams({ limit: String(Math.min(Number(limit) || 20, 50)) });
        const url = `https://api.plivo.com/v1/Account/${auth.authId}/Call/?${qs}`;
        const response = await fetch(url, {
            headers: { Authorization: auth.header },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return [];
        const data = await response.json().catch(() => ({}));
        const objects = Array.isArray(data.objects) ? data.objects : [];
        if (!to) return objects;
        const needle = String(to).replace(/\D/g, "").slice(-10);
        return objects.filter((row) => String(row.to || row.to_number || "").replace(/\D/g, "").slice(-10) === needle);
    }

    getMissingConfiguration() {
        const missing = [];
        if (!process.env.PLIVO_AUTH_ID && !process.env.PLIVO_AGENT_AUTH_ID) missing.push("PLIVO_AUTH_ID");
        if (!process.env.PLIVO_AUTH_TOKEN && !process.env.PLIVO_AGENT_AUTH_TOKEN) missing.push("PLIVO_AUTH_TOKEN");
        if (!process.env.PLIVO_PHONE_NUMBER) missing.push("PLIVO_PHONE_NUMBER");
        return missing;
    }

    async execute(lead, action, payload = {}) {
        if (!lead || !lead.phone) {
            return {
                channel: "VOICE",
                status: "FAILED",
                error: "Lead has no phone number",
                rawResponse: null,
            };
        }

        let to = String(lead.phone || "").replace(/[^\d+]/g, "");
        if (to.startsWith("0") && to.length === 11) {
            to = "+91" + to.slice(1);
        } else if (!to.startsWith("+") && to.length === 10 && /^[6-9]/.test(to)) {
            to = "+91" + to;
        } else if (!to.startsWith("+") && to.length === 12 && to.startsWith("91")) {
            to = "+" + to;
        }

        const digitsOnly = to.replace(/[^\d]/g, "");
        if (digitsOnly.length < 10 || digitsOnly.length > 15) {
            return {
                channel: "VOICE",
                status: "FAILED",
                error: `Lead phone number is unverified or invalid: ${lead.phone}`,
                rawResponse: null,
            };
        }

        const from = String(payload.from || process.env.PLIVO_PHONE_NUMBER || "+15550001234").replace(/[^\d+]/g, "");
        let effectiveBaseUrl = (process.env.PUBLIC_API_URL || env.publicApiUrl || env.frontendUrl || "http://localhost:3001").replace(/\/$/, "");
        try {
            const ngrokRes = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(600) });
            if (ngrokRes.ok) {
                const tunnelData = await ngrokRes.json();
                const activeTunnel = tunnelData.tunnels?.[0]?.public_url;
                if (activeTunnel) {
                    effectiveBaseUrl = activeTunnel.replace(/\/$/, "");
                }
            }
        } catch (_) {}

        const research = this.readCompanyResearch(lead);
        const playbookVoice = await tryPlaybookVoice(lead).catch(() => null);
        const openingLine = playbookVoice?.openingLine || this.buildCallSpeech(lead, payload.prompt);
        const qParams = new URLSearchParams();
        if (lead.name) qParams.set("leadName", lead.name);
        if (lead.company) qParams.set("company", lead.company);
        if (payload.prompt) qParams.set("message", payload.prompt);
        if (lead.id) qParams.set("leadId", String(lead.id));
        if (lead.organization_id) qParams.set("orgId", String(lead.organization_id));
        if (payload.callId) qParams.set("callId", String(payload.callId));
        const webhookToken = process.env.VOICE_WEBHOOK_SECRET || "";
        if (webhookToken) qParams.set("token", webhookToken);

        const qs = qParams.toString() ? `?${qParams.toString()}` : "";
        const answerUrl = payload.answerUrl || `${effectiveBaseUrl}/api/engine/voice/plivo/answer${qs}`;
        const callbackUrl = payload.callbackUrl || `${effectiveBaseUrl}/api/engine/voice/plivo/status${qs}`;
        const agentflowResultUrl = payload.agentflowResultUrl || `${effectiveBaseUrl}/api/engine/voice/plivo/agentflow${qs}`;

        if (!this.isConfigured()) {
            if (payload.requireRealProvider) {
                const missing = this.getMissingConfiguration();
                return {
                    channel: "VOICE",
                    status: "FAILED",
                    error: `Plivo provider not configured. Missing: ${missing.join(", ")}`,
                    rawResponse: { missingConfiguration: missing },
                };
            }

            const simulatedCallId = `plivo_sim_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            return {
                channel: "VOICE",
                status: "SUCCEEDED",
                rawResponse: {
                    simulated: true,
                    provider: "plivo",
                    providerCallId: simulatedCallId,
                    to,
                    from,
                },
                metadata: {
                    callId: simulatedCallId,
                    providerCallId: simulatedCallId,
                    phone: to,
                    provider: "plivo",
                },
            };
        }

        const authId = process.env.PLIVO_AUTH_ID || process.env.PLIVO_AGENT_AUTH_ID;
        const authToken = process.env.PLIVO_AUTH_TOKEN || process.env.PLIVO_AGENT_AUTH_TOKEN;
        const basicAuth = Buffer.from(`${authId}:${authToken}`).toString("base64");
        const agentflowUrl = (process.env.PLIVO_AGENT_API_URL || process.env.CALLING_BOT_API_URL || "").trim();
        const flowId = agentflowUrl.match(/\/flow\/([^/?#]+)/i)?.[1] || null;

        if (agentflowUrl) {
            const agentPayload = {
                to,
                from,
                record: Boolean(payload.record),
                name: lead.name || "",
                company: lead.company || research?.company || "",
                lead_name: lead.name || "",
                company_name: lead.company || research?.company || "",
                leadName: lead.name || "",
                companyName: lead.company || research?.company || "",
                email: lead.email || "",
                phone: to,
                lead_id: String(lead.id || ""),
                organization_id: String(lead.organization_id || ""),
                opening_line: openingLine,
                callback_url: agentflowResultUrl,
                result_url: agentflowResultUrl,
                hangup_url: callbackUrl,
                status_callback_url: callbackUrl,
                variables: {
                    to,
                    from,
                    name: lead.name || "",
                    company: lead.company || research?.company || "",
                    lead_name: lead.name || "",
                    company_name: lead.company || research?.company || "",
                    company_summary: research?.summary || "",
                    industry: research?.industry || "",
                    opening_line: openingLine,
                    email: lead.email || "",
                    phone: to,
                    lead_id: String(lead.id || ""),
                    organization_id: String(lead.organization_id || ""),
                    callback_url: agentflowResultUrl,
                    result_url: agentflowResultUrl,
                    hangup_url: callbackUrl,
                    status_callback_url: callbackUrl,
                    ...(playbookVoice?.variables || {}),
                },
            };

            try {
                const agentResponse = await fetch(agentflowUrl, {
                    method: "POST",
                    headers: {
                        Authorization: `Basic ${basicAuth}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(agentPayload),
                    signal: AbortSignal.timeout(15000),
                });

                const agentData = await agentResponse.json().catch(() => ({}));
                if (!agentResponse.ok) {
                    const error = agentData.message || agentData.error || agentData.detail
                        || `Agentflow returned ${agentResponse.status}`;
                    console.error(`[ASE][Plivo] Agentflow trigger failed (${agentResponse.status}): ${error}`);
                    return {
                        channel: "VOICE",
                        status: "FAILED",
                        error: `Plivo Agentflow failed: ${error}`,
                        rawResponse: agentData,
                    };
                }

                const resolvedUuid = agentData.request_uuid
                    || agentData.call_uuid
                    || agentData.CallUUID
                    || agentData.api_id
                    || agentData.phlo_id
                    || agentData.id
                    || `agentflow_${Date.now()}`;
                console.log(`[ASE][Plivo] Agentflow triggered flow=${flowId || "configured"} uuid=${resolvedUuid}`);
                return {
                    channel: "VOICE",
                    status: "SUCCEEDED",
                    rawResponse: agentData,
                    metadata: {
                        callId: resolvedUuid,
                        providerCallId: resolvedUuid,
                        phone: to,
                        provider: "plivo_agentflow",
                        flowId,
                    },
                };
            } catch (error) {
                console.error(`[ASE][Plivo] Agentflow request error: ${error.message}`);
                return {
                    channel: "VOICE",
                    status: "FAILED",
                    error: `Plivo Agentflow request failed: ${error.message}`,
                    rawResponse: null,
                };
            }
        }

        const plivoUrl = `https://api.plivo.com/v1/Account/${authId}/Call/`;

        try {
            const response = await fetch(plivoUrl, {
                method: "POST",
                headers: {
                    Authorization: `Basic ${basicAuth}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    from,
                    to,
                    answer_url: answerUrl,
                    answer_method: "POST",
                    hangup_url: callbackUrl,
                    hangup_method: "POST",
                    callback_url: callbackUrl,
                    callback_method: "POST",
                    record: Boolean(payload.record),
                    extra_dial_string: payload.extraDialString || "",
                }),
            });

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                return {
                    channel: "VOICE",
                    status: "FAILED",
                    error: data.message || `Plivo call failed with status ${response.status}`,
                    rawResponse: data,
                };
            }

            return {
                channel: "VOICE",
                status: "SUCCEEDED",
                rawResponse: data,
                metadata: {
                    callId: data.request_uuid || data.api_id,
                    providerCallId: data.request_uuid || data.api_id,
                    phone: to,
                    provider: "plivo",
                },
            };
        } catch (error) {
            return {
                channel: "VOICE",
                status: "FAILED",
                error: error.message,
                rawResponse: null,
            };
        }
    }

    readCompanyResearch(lead) {
        const meta = lead?.metadata;
        if (!meta) return null;
        const parsed = typeof meta === "string" ? (() => { try { return JSON.parse(meta); } catch { return {}; } })() : meta;
        return parsed.company_research || null;
    }

    buildCallSpeech(lead, customMessage) {
        if (customMessage && String(customMessage).trim()) return String(customMessage).trim();
        const firstName = String(lead?.name || "there").trim().split(/\s+/)[0] || "there";
        const research = this.readCompanyResearch(lead);
        const company = research?.company || lead?.company || "your company";
        const summary = String(research?.summary || "").replace(/\s+/g, " ").trim().slice(0, 180);
        const industry = String(research?.industry || "").replace(/\s+/g, " ").trim();
        const about = summary || (industry ? `${company} works in ${industry}` : company);
        return `Hello ${firstName}, this is Nova from Evoke AI. I was looking at ${company}. ${about}. Do you have thirty seconds?`;
    }

    escapeXml(value = "") {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");
    }

    generateAnswerXml({ message, leadName = "there", lead } = {}) {
        const speechText = message || this.buildCallSpeech(lead || { name: leadName });
        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="Polly.Aditi" language="en-IN">${this.escapeXml(speechText)}</Speak>
</Response>`;
    }

    generateConferenceXml({ conferenceName, message, endOnExit = false } = {}) {
        const room = this.escapeXml(conferenceName || "ase-transfer");
        const speech = message
            ? `<Speak voice="Polly.Aditi" language="en-IN">${this.escapeXml(message)}</Speak>`
            : "";
        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    ${speech}
    <Conference startConferenceOnEnter="true" endConferenceOnExit="${endOnExit ? "true" : "false"}" maxMembers="3">${room}</Conference>
</Response>`;
    }

    generateCallbackPromiseXml(message) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="Polly.Aditi" language="en-IN">${this.escapeXml(message)}</Speak>
    <Hangup/>
</Response>`;
    }

    generateClickToCallDialXml({ leadNumber, callerId, timeout = 45, dialCallbackUrl } = {}) {
        const lead = this.escapeXml(leadNumber || "");
        const from = this.escapeXml(callerId || process.env.PLIVO_PHONE_NUMBER || "");
        const wait = Number(timeout) > 0 ? Number(timeout) : 45;
        const callback = dialCallbackUrl
            ? ` callbackUrl="${this.escapeXml(dialCallbackUrl)}" callbackMethod="POST"`
            : "";
        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial callerId="${from}" timeout="${wait}" timeLimit="3600" hangupOnStar="false" record="true"${callback}>
        <Number>${lead}</Number>
    </Dial>
</Response>`;
    }

    mpcPath(name, suffix = "") {
        const room = encodeURIComponent(String(name || "").trim());
        return `/MultiPartyCall/name_${room}/${suffix}`;
    }

    extractCallUuid(data = {}) {
        if (typeof data.request_uuid === "string" && data.request_uuid) return data.request_uuid;
        if (Array.isArray(data.request_uuid) && data.request_uuid[0]) return data.request_uuid[0];
        if (Array.isArray(data.calls) && data.calls[0]) {
            return data.calls[0].call_uuid || data.calls[0].request_uuid || null;
        }
        if (data.calls && typeof data.calls === "object") {
            const first = Object.values(data.calls)[0];
            if (typeof first === "string") return first;
            if (first?.call_uuid) return first.call_uuid;
        }
        return data.call_uuid || null;
    }

    async startClickToCallLeg({ to, from, mpcName } = {}) {
        const dest = String(to || "").trim();
        const room = String(mpcName || "").trim();
        if (!dest || !room) {
            return { status: "FAILED", error: "Primary phone and conference name are required" };
        }
        if (!this.isConfigured()) {
            return { status: "FAILED", error: "Plivo is not configured for click-to-call" };
        }
        const result = await this.plivoPost(this.mpcPath(room, "Participant/"), {
            role: "agent",
            from: from || process.env.PLIVO_PHONE_NUMBER,
            to: dest,
            start_mpc_on_enter: true,
            stay_alone: true,
            end_mpc_on_exit: false,
            ring_timeout: 60,
            max_duration: 3600,
            max_participants: 2,
            enter_sound: "none",
            exit_sound: "none",
            dial_music: "real",
            record: true,
        });
        const uuid = this.extractCallUuid(result.rawResponse || {});
        if (uuid) {
            result.metadata = { ...(result.metadata || {}), callId: uuid };
            result.rawResponse = { ...(result.rawResponse || {}), request_uuid: uuid };
        }
        return result;
    }

    async addClickToCallLeadLeg({ mpcName, to, from } = {}) {
        const dest = String(to || "").trim();
        const room = String(mpcName || "").trim();
        if (!dest || !room) {
            return { status: "FAILED", error: "Lead phone and conference name are required" };
        }
        if (!this.isConfigured()) {
            return { status: "FAILED", error: "Plivo is not configured for click-to-call" };
        }
        const result = await this.plivoPost(this.mpcPath(room, "Participant/"), {
            role: "customer",
            from: from || process.env.PLIVO_PHONE_NUMBER,
            to: dest,
            start_mpc_on_enter: true,
            stay_alone: false,
            end_mpc_on_exit: true,
            ring_timeout: 45,
            enter_sound: "none",
            exit_sound: "none",
            record: true,
        });
        const uuid = this.extractCallUuid(result.rawResponse || {});
        if (uuid) {
            result.metadata = { ...(result.metadata || {}), callId: uuid };
            result.rawResponse = { ...(result.rawResponse || {}), request_uuid: uuid, call_uuid: uuid };
        }
        return result;
    }

    async listMpcParticipants(mpcName) {
        const room = String(mpcName || "").trim();
        if (!room) return [];
        const data = await this.plivoGet(this.mpcPath(room, "Participant/"));
        return Array.isArray(data?.objects) ? data.objects : [];
    }

    async plivoGet(path) {
        const auth = this.getAccountAuth();
        if (!auth) return null;
        const url = `https://api.plivo.com/v1/Account/${auth.authId}${path}`;
        try {
            const response = await fetch(url, {
                headers: { Authorization: auth.header },
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) return null;
            return response.json().catch(() => null);
        } catch {
            return null;
        }
    }

    async plivoPost(path, body) {
        const auth = this.getAccountAuth();
        if (!auth) {
            return { status: "SUCCEEDED", rawResponse: { simulated: true, path, body } };
        }
        const url = `https://api.plivo.com/v1/Account/${auth.authId}${path}`;
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    Authorization: auth.header,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(12000),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                return { status: "FAILED", error: data.message || `Plivo ${response.status}`, rawResponse: data };
            }
            return { status: "SUCCEEDED", rawResponse: data, metadata: { callId: data.request_uuid || data.api_id } };
        } catch (error) {
            return { status: "FAILED", error: error.message, rawResponse: null };
        }
    }

    async transferLiveCall(callUuid, answerUrl) {
        if (!callUuid || !answerUrl) {
            return { status: "FAILED", error: "callUuid and answerUrl are required" };
        }
        if (!this.isConfigured()) {
            return { status: "FAILED", error: "Plivo is not configured for warm transfer" };
        }
        return this.plivoPost(`/Call/${encodeURIComponent(callUuid)}/`, {
            legs: "aleg",
            aleg_url: answerUrl,
            aleg_method: "POST",
        });
    }

    async dialIntoConference(to, { answerUrl, hangupUrl, from } = {}) {
        const dest = String(to || "").trim();
        if (!dest || !answerUrl) {
            return { status: "FAILED", error: "rep number and answerUrl are required" };
        }
        if (!this.isConfigured()) {
            return { status: "FAILED", error: "Plivo is not configured for warm transfer" };
        }
        return this.plivoPost("/Call/", {
            from: from || process.env.PLIVO_PHONE_NUMBER,
            to: dest,
            answer_url: answerUrl,
            answer_method: "POST",
            hangup_url: hangupUrl || undefined,
            hangup_method: hangupUrl ? "POST" : undefined,
        });
    }

    async speakAndHangup(callUuid, message) {
        if (!callUuid) return { status: "FAILED", error: "callUuid is required" };
        if (!this.isConfigured()) {
            return { status: "FAILED", error: "Plivo is not configured for warm transfer" };
        }
        const base = await resolvePublicBaseUrl();
        const params = new URLSearchParams();
        if (process.env.VOICE_WEBHOOK_SECRET) params.set("token", process.env.VOICE_WEBHOOK_SECRET);
        params.set("promise", "1");
        params.set("message", String(message || "").slice(0, 240));
        const answerUrl = `${base}/api/engine/voice/plivo/transfer/promise?${params.toString()}`;
        return this.transferLiveCall(callUuid, answerUrl);
    }

    extractConversationOutcome(transcript = "") {
        return classifyProspectSpeech(transcript);
    }
}

export const plivoVoiceAdapter = new PlivoVoiceAdapter();

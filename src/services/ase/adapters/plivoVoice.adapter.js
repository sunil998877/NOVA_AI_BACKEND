import { BaseChannelAdapter } from "./base.adapter.js";
import { ASE_OUTCOMES } from "../outcomeNormalizer.service.js";
import { env } from "../../../config/env.js";

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

        const qParams = new URLSearchParams();
        if (lead.name) qParams.set("leadName", lead.name);
        if (payload.prompt) qParams.set("message", payload.prompt);
        if (lead.id) qParams.set("leadId", String(lead.id));
        if (lead.organization_id) qParams.set("orgId", String(lead.organization_id));
        if (payload.callId) qParams.set("callId", String(payload.callId));

        const qs = qParams.toString() ? `?${qParams.toString()}` : "";
        const answerUrl = payload.answerUrl || `${effectiveBaseUrl}/api/engine/voice/plivo/answer${qs}`;
        const callbackUrl = payload.callbackUrl || `${effectiveBaseUrl}/api/engine/voice/plivo/status${qs}`;

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
        const agentflowUrl = (process.env.PLIVO_AGENT_API_URL || "").trim();

        if (agentflowUrl) {
            try {
                const agentResponse = await fetch(agentflowUrl, {
                    method: "POST",
                    headers: {
                        Authorization: `Basic ${basicAuth}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        to,
                        from,
                        lead_name: lead.name || "",
                        company_name: lead.company || "",
                        leadName: lead.name || "",
                        companyName: lead.company || "",
                        name: lead.name || "",
                        company: lead.company || "",
                        variables: {
                            lead_name: lead.name || "",
                            company_name: lead.company || "",
                            leadName: lead.name || "",
                            companyName: lead.company || "",
                            name: lead.name || "",
                            company: lead.company || "",
                            email: lead.email || "",
                            phone: to,
                            lead_id: String(lead.id || ""),
                            organization_id: String(lead.organization_id || "1"),
                        },
                        parameters: {
                            lead_name: lead.name || "",
                            company_name: lead.company || "",
                            leadName: lead.name || "",
                            companyName: lead.company || "",
                            name: lead.name || "",
                            company: lead.company || "",
                        },
                    }),
                });

                const agentData = await agentResponse.json().catch(() => ({}));
                if (agentResponse.ok) {
                    const resolvedUuid = agentData.request_uuid || agentData.api_id || agentData.phlo_id || `agent_${Date.now()}`;
                    return {
                        channel: "VOICE",
                        status: "SUCCEEDED",
                        rawResponse: agentData,
                        metadata: {
                            callId: resolvedUuid,
                            providerCallId: resolvedUuid,
                            phone: to,
                            provider: "plivo_agentflow",
                            flowId: agentData.phlo_id || "2c0b21ef-0183-4e77-99be-bc86ef57a36e",
                        },
                    };
                }
            } catch (_) {}
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
                    callback_url: callbackUrl,
                    callback_method: "POST",
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
                    callId: data.request_uuid,
                    providerCallId: data.request_uuid,
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

    generateAnswerXml({ message, leadName = "there" } = {}) {
        const speechText =
            message ||
            `Hello ${leadName}! This is NOVA's autonomous sales assistant calling. Did I catch you at a convenient moment to speak about your outbound sales automation?`;

        return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Speak voice="Polly.Aditi" rate="90%">${speechText}</Speak>
    <Wait length="15"/>
</Response>`;
    }

    extractConversationOutcome(transcript = "") {
        const text = String(transcript || "").toLowerCase();

        if (
            text.includes("do not call") ||
            text.includes("stop calling") ||
            text.includes("remove me") ||
            text.includes("don't call")
        ) {
            return {
                outcome: ASE_OUTCOMES.DNC,
                disposition: "do_not_call",
                isDnc: true,
                callbackRequested: false,
                interested: false,
            };
        }

        if (
            text.includes("call me back") ||
            text.includes("call tomorrow") ||
            text.includes("call later") ||
            text.includes("bad time") ||
            text.includes("callback")
        ) {
            return {
                outcome: ASE_OUTCOMES.CALLBACK,
                disposition: "callback_requested",
                isDnc: false,
                callbackRequested: true,
                interested: false,
            };
        }

        if (
            text.includes("interested") ||
            text.includes("sounds good") ||
            text.includes("tell me more") ||
            text.includes("send details") ||
            text.includes("book a call")
        ) {
            return {
                outcome: ASE_OUTCOMES.INTERESTED,
                disposition: "interested",
                isDnc: false,
                callbackRequested: false,
                interested: true,
            };
        }

        if (
            text.includes("not interested") ||
            text.includes("no thank you") ||
            text.includes("not looking") ||
            text.includes("no thanks")
        ) {
            return {
                outcome: ASE_OUTCOMES.NOT_INTERESTED,
                disposition: "not_interested",
                isDnc: false,
                callbackRequested: false,
                interested: false,
            };
        }

        if (!text.trim()) {
            return {
                outcome: ASE_OUTCOMES.AMBIGUOUS,
                disposition: "connected_unspecified",
                isDnc: false,
                callbackRequested: false,
                interested: false,
            };
        }

        return {
            outcome: ASE_OUTCOMES.AMBIGUOUS,
            disposition: "unclassified",
            isDnc: false,
            callbackRequested: false,
            interested: false,
        };
    }
}

export const plivoVoiceAdapter = new PlivoVoiceAdapter();

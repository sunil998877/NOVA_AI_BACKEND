
import { env } from "../config/env.js";
import { fetchWithTimeout } from "./fetch.js";

function buildN8nHeaders(contentType = null) {
    const headers = { "User-Agent": "NovaAI-Backend/1.0" };
    if (env.n8nUser && env.n8nPassword) {
        headers.Authorization = `Basic ${Buffer.from(
            `${env.n8nUser}:${env.n8nPassword}`
        ).toString("base64")}`;
    }
    if (contentType) headers["Content-Type"] = contentType;
    return headers;
}

function pingTestWebhook(testUrl, method, body, query) {
    const url = query ? `${testUrl}?${query}` : testUrl;
    const opts = {
        method,
        headers: buildN8nHeaders(method !== "GET" ? "application/json" : null),
    };
    if (method !== "GET" && body) opts.body = JSON.stringify(body);
    fetchWithTimeout(url, opts, 2000)
        .then((r) => { if (r.ok) console.log(`[n8n] Test webhook triggered (${method}):`, r.status); })
        .catch(() => {});
}

export async function sendCampaignViaN8n(payload) {
    const webhookUrl = env.n8nWebhookUrl;
    if (!webhookUrl) return null;

    const headers = buildN8nHeaders("application/json");
    const body = JSON.stringify(payload);

    async function tryPost(url) {
        return fetchWithTimeout(url, { method: "POST", headers, body }, 15_000);
    }

    if (webhookUrl.includes("/webhook/")) {
        pingTestWebhook(
            webhookUrl.replace("/webhook/", "/webhook-test/"),
            "POST",
            payload
        );
    }

    let res = await tryPost(webhookUrl);
    console.log("[n8n] Campaign POST response:", res.status);

    if (res.status === 404 && webhookUrl.includes("/webhook/")) {
        const testUrl = webhookUrl.replace("/webhook/", "/webhook-test/");
        console.log("[n8n] Production webhook 404 — retrying with test URL:", testUrl);
        try {
            res = await tryPost(testUrl);
            console.log("[n8n] Test webhook response:", res.status);
        } catch (err) {
            console.warn("[n8n] Test webhook also failed:", err.message);
        }
    }

    return res;
}

export async function sendCampaignViaN8nGET(payload) {
    const webhookUrl = env.n8nWebhookUrl;
    if (!webhookUrl) return null;

    const headers = buildN8nHeaders();
    const effectiveSenderName = payload.senderName || env.novaSenderName;
    const effectiveSenderEmail = payload.senderEmail || env.novaSenderEmail;
    const firstRecipient = (payload.recipients && payload.recipients[0]) || {};

    const query = new URLSearchParams({
        campaignId: String(payload.campaignId),
        action: payload.action || "start_campaign",
        timestamp: payload.timestamp || new Date().toISOString(),
        totalRecipients: String(payload.totalRecipients ?? 0),
        senderEmail: effectiveSenderEmail,
        senderName: effectiveSenderName,
        from: payload.from || `"${effectiveSenderName}" <${effectiveSenderEmail}>`,
    });

    if (payload.subject)     query.set("subject", payload.subject);
    if (payload.body)        query.set("body", payload.body);
    if (payload.html)        query.set("html", payload.html);
    if (payload.accessToken) query.set("accessToken", payload.accessToken);
    if (payload.apiBaseUrl)  query.set("apiBaseUrl", payload.apiBaseUrl);

    if (firstRecipient.email || firstRecipient.recipientEmail) {
        const toEmail = firstRecipient.email || firstRecipient.recipientEmail;
        const toName = firstRecipient.recipientName || firstRecipient.full_name || "";
        query.set("to", toEmail);
        query.set("email", toEmail);
        query.set("recipientEmail", toEmail);
        if (toName) query.set("recipientName", toName);
    }

    if (payload.recipients) {
        const compact = payload.recipients.map((r) => ({
            id: r.id,
            email: r.email || r.recipientEmail,
            recipientEmail: r.recipientEmail || r.email,
            full_name: r.full_name || r.recipientName || "",
            recipientName: r.recipientName || r.full_name || "",
        }));
        query.set("recipients", JSON.stringify(compact));
    }

    const fullUrl = `${webhookUrl}?${query}`;
    console.log("[n8n] GET →", webhookUrl, "| campaignId:", payload.campaignId, "| recipients:", payload.totalRecipients);

    if (webhookUrl.includes("/webhook/")) {
        pingTestWebhook(
            webhookUrl.replace("/webhook/", "/webhook-test/"),
            "GET",
            null,
            query
        );
    }

    const res = await fetchWithTimeout(fullUrl, { method: "GET", headers }, 15_000);
    console.log("[n8n] GET response:", res.status);
    return res;
}

export async function callN8nWebhook(payload) {
    if (!env.n8nWebhookUrl) return null;
    const method = String(env.n8nWebhookMethod || "POST").toUpperCase();
    return method === "GET"
        ? sendCampaignViaN8nGET(payload)
        : sendCampaignViaN8n(payload);
}

export async function sendSingleViaN8n({ to, subject, html, text, from }) {
    const webhookUrl = env.n8nWebhookUrl;
    if (!webhookUrl) return null;

    const senderName = env.novaSenderName || "NOVA AI";
    const senderEmail = env.smtp.user || env.novaSenderEmail || "nova@evokeaisolutions.com";
    const effectiveFrom = from || `"${senderName}" <${senderEmail}>`;

    const payload = {
        action: "start_campaign",
        to,
        email: to,
        recipientEmail: to,
        recipientName: "",
        subject,
        body: text || (html ? html.replace(/<[^>]+>/g, "") : ""),
        html,
        from: effectiveFrom,
        senderEmail,
        senderName,
        timestamp: new Date().toISOString(),
        totalRecipients: 1,
        recipients: [{ id: 1, email: to, recipientEmail: to, full_name: "", recipientName: "" }],
    };

    const res = await callN8nWebhook(payload);
    if (!res || !res.ok) {
        throw new Error(`n8n responded with status ${res?.status ?? "no response"}`);
    }
    return { messageId: `n8n-${Date.now()}`, deliveryMethod: "n8n_webhook" };
}

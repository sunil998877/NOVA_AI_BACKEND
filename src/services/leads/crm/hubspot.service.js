import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../../../config/env.js";
import { CrmConnection } from "../../../models/crm-connection.model.js";
import { processBatch, processLead, LEAD_SOURCES } from "../leadIntake.service.js";

const PROVIDER = "hubspot";
const API_BASE = "https://api.hubapi.com";
const AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const CONTACT_PROPS = ["email", "firstname", "lastname", "company", "phone", "lastmodifieddate"];

const cfg = () => env.hubspot;

export const isOAuthConfigured = () => Boolean(cfg().clientId && cfg().clientSecret && cfg().redirectUri);

export function buildAuthorizeUrl(userId) {
    if (!isOAuthConfigured()) {
        throw new Error("HubSpot OAuth is not configured (HUBSPOT_CLIENT_ID / SECRET / REDIRECT_URI)");
    }
    const state = jwt.sign({ sub: String(userId), p: PROVIDER }, env.jwtSecret, { expiresIn: "10m" });
    const params = new URLSearchParams({
        client_id: cfg().clientId,
        redirect_uri: cfg().redirectUri,
        scope: cfg().scopes,
        state,
    });
    return `${AUTH_URL}?${params}`;
}

export function verifyState(state) {
    const payload = jwt.verify(String(state || ""), env.jwtSecret);
    if (payload.p !== PROVIDER) throw new Error("Invalid OAuth state");
    return payload.sub;
}

async function tokenRequest(body) {
    const res = await fetch(`${API_BASE}/oauth/v1/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: cfg().clientId,
            client_secret: cfg().clientSecret,
            ...body,
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HubSpot token request failed (${res.status})`);
    return data;
}

async function fetchPortalId(accessToken) {
    try {
        const res = await fetch(`${API_BASE}/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.hub_id ? String(data.hub_id) : null;
    } catch {
        return null;
    }
}

const expiryFrom = (seconds) =>
    seconds ? new Date(Date.now() + (Number(seconds) - 60) * 1000) : null;

export async function exchangeCode(userId, code) {
    const data = await tokenRequest({
        grant_type: "authorization_code",
        redirect_uri: cfg().redirectUri,
        code,
    });
    const portalId = await fetchPortalId(data.access_token);
    return CrmConnection.upsert({
        userId,
        provider: PROVIDER,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: expiryFrom(data.expires_in),
        portalId,
    });
}

export async function connectWithPrivateToken(userId, accessToken) {
    const res = await fetch(`${API_BASE}/crm/v3/objects/contacts?limit=1`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error("HubSpot rejected this token. Check the private app scopes (crm.objects.contacts.read).");
    return CrmConnection.upsert({ userId, provider: PROVIDER, accessToken, refreshToken: null, expiresAt: null });
}

async function getAccessToken(userId) {
    const conn = await CrmConnection.find(userId, PROVIDER);
    if (!conn) throw new Error("HubSpot is not connected");

    const expired = conn.expires_at && new Date(conn.expires_at).getTime() <= Date.now();
    if (!expired) return conn.access_token;
    if (!conn.refresh_token) throw new Error("HubSpot token expired. Please reconnect.");

    const data = await tokenRequest({ grant_type: "refresh_token", refresh_token: conn.refresh_token });
    await CrmConnection.upsert({
        userId,
        provider: PROVIDER,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: expiryFrom(data.expires_in),
    });
    return data.access_token;
}

async function hubspotFetch(userId, path, options = {}) {
    const token = await getAccessToken(userId);
    const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HubSpot API error (${res.status})`);
    return data;
}

export const toLead = (contact) => {
    const p = contact.properties || {};
    return {
        email: p.email,
        firstName: p.firstname,
        lastName: p.lastname,
        company: p.company,
        phone: p.phone,
        externalId: contact.id,
        metadata: { hubspotUpdatedAt: p.lastmodifieddate || contact.updatedAt || null },
    };
};

export async function syncContacts(userId, { full = false } = {}) {
    const conn = await CrmConnection.find(userId, PROVIDER);
    if (!conn) throw new Error("HubSpot is not connected");

    const since = !full && conn.last_synced_at ? new Date(conn.last_synced_at).getTime() : null;
    const contacts = [];
    let after;

    do {
        let page;
        if (since) {
            page = await hubspotFetch(userId, "/crm/v3/objects/contacts/search", {
                method: "POST",
                body: JSON.stringify({
                    filterGroups: [
                        { filters: [{ propertyName: "lastmodifieddate", operator: "GTE", value: String(since) }] },
                    ],
                    properties: CONTACT_PROPS,
                    limit: 100,
                    after,
                }),
            });
        } else {
            const qs = new URLSearchParams({ limit: "100", properties: CONTACT_PROPS.join(",") });
            if (after) qs.set("after", after);
            page = await hubspotFetch(userId, `/crm/v3/objects/contacts?${qs}`);
        }
        contacts.push(...(page.results || []));
        after = page.paging?.next?.after;
    } while (after && contacts.length < 10_000);

    const leads = contacts.map(toLead).filter((l) => l.email);
    const summary = await processBatch(leads, {
        userId,
        source: LEAD_SOURCES.CRM_HUBSPOT,
        updateExisting: true,
    });
    summary.fetched = contacts.length;
    summary.withoutEmail = contacts.length - leads.length;

    await CrmConnection.markSynced(userId, PROVIDER);
    return summary;
}

export async function syncSingleContact(userId, contactId) {
    const qs = new URLSearchParams({ properties: CONTACT_PROPS.join(",") });
    const contact = await hubspotFetch(userId, `/crm/v3/objects/contacts/${contactId}?${qs}`);
    const lead = toLead(contact);
    if (!lead.email) return { status: "skipped", reason: "no email" };
    return processLead(lead, { userId, source: LEAD_SOURCES.CRM_HUBSPOT, updateExisting: true });
}

export function verifyWebhookSignature(req) {
    const secret = cfg().clientSecret;
    if (!secret) return false;

    const signature = req.headers["x-hubspot-signature-v3"];
    const timestamp = req.headers["x-hubspot-request-timestamp"];
    if (!signature || !timestamp) return false;
    if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false;

    const uri = cfg().webhookUrl || `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const source = `${req.method}${uri}${req.rawBody || ""}${timestamp}`;
    const expected = crypto.createHmac("sha256", secret).update(source).digest("base64");

    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function handleWebhookEvents(events) {
    const list = Array.isArray(events) ? events : [];
    const results = [];
    for (const event of list) {
        if (!String(event.subscriptionType || "").startsWith("contact.")) continue;
        if (event.subscriptionType === "contact.deletion") continue;
        const connections = await CrmConnection.findByPortal(PROVIDER, event.portalId);
        for (const conn of connections) {
            try {
                const r = await syncSingleContact(conn.user_id, event.objectId);
                results.push({ userId: conn.user_id, objectId: event.objectId, status: r.status });
            } catch (error) {
                results.push({ userId: conn.user_id, objectId: event.objectId, error: error.message });
            }
        }
    }
    return results;
}

export async function getStatus(userId) {
    const conn = await CrmConnection.find(userId, PROVIDER);
    return {
        provider: PROVIDER,
        oauthConfigured: isOAuthConfigured(),
        connected: Boolean(conn),
        portalId: conn?.portal_id || null,
        lastSyncedAt: conn?.last_synced_at || null,
    };
}

export async function disconnect(userId) {
    await CrmConnection.remove(userId, PROVIDER);
}

export const HubSpotService = {
    buildAuthorizeUrl,
    verifyState,
    exchangeCode,
    connectWithPrivateToken,
    syncContacts,
    syncSingleContact,
    verifyWebhookSignature,
    handleWebhookEvents,
    getStatus,
    disconnect,
    isOAuthConfigured,
};

import dns from "dns";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { query } from "../../config/db.js";
import { env } from "../../config/env.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { FollowUpEnrollment } from "../../models/follow-up-enrollment.model.js";
import { OrchestratorService } from "./orchestrator.service.js";
import { normalizeChannelOutcome, ASE_OUTCOMES } from "./outcomeNormalizer.service.js";
import { getIo } from "../../socket/socketServer.js";
import { followUpEngine } from "../followup/followUpEngine.service.js";

function extractCleanReply(text) {
    if (!text) return "";
    const lines = text.split("\n");
    const clean = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (/^on\s.+wrote:?$/i.test(trimmed)) break;
        if (/^-{2,}\s*original message\s*-{2,}/i.test(trimmed)) break;
        if (trimmed.startsWith(">")) continue;
        clean.push(line);
    }
    const result = clean.join("\n").trim();
    return result || text.trim();
}

function extractEmailAddress(raw) {
    if (!raw) return "";
    const match = raw.match(/<([^>]+)>/);
    if (match && match[1]) {
        return match[1].toLowerCase().trim();
    }
    return raw.replace(/["']/g, "").toLowerCase().trim();
}

function isPlaceholder(value) {
    if (!value) return true;
    const lower = String(value).toLowerCase().trim();
    return (
        lower.includes("your-email") ||
        lower.includes("yourdomain") ||
        lower.includes("your_mailbox_password") ||
        lower.includes("placeholder") ||
        lower.includes("<redacted>")
    );
}

class EmailReplyListenerService {
    constructor() {
        this.pollIntervalMs = 15000;
        this.timer = null;
        this.isPolling = false;
        this.isRunning = false;
        this.consecutiveFailures = 0;
        this.lastErrorMessage = null;
        this.lastErrorLogTime = 0;
        this.currentClient = null;
        this.processedMessageIds = new Set();
    }

    getConfig() {
        const imapEnv = env.imap || {};
        const host = String(process.env.IMAP_HOST || imapEnv.host || (process.env.SMTP_HOST ? process.env.SMTP_HOST.replace(/^smtp\./i, "imap.") : "imap.hostinger.com")).trim();
        const port = Number(process.env.IMAP_PORT || imapEnv.port || 993);
        const secure = process.env.IMAP_SECURE !== "false" && imapEnv.secure !== false;
        const user = String(process.env.IMAP_USER || imapEnv.user || process.env.SMTP_USER || "").trim();
        const pass = String(process.env.IMAP_PASS || process.env.IMAP_PASSWORD || imapEnv.pass || process.env.SMTP_PASS || "").trim();
        const enabled = process.env.IMAP_ENABLED !== "false" && imapEnv.enabled !== false;
        return { host, port, secure, user, pass, enabled };
    }

    logError(category, message) {
        const now = Date.now();
        if (this.lastErrorMessage === message && now - this.lastErrorLogTime < 60000) {
            return;
        }
        this.lastErrorMessage = message;
        this.lastErrorLogTime = now;
        console.error(`[EmailReplyListener] [${category}] ${message}`);
    }

    logRecovery(host, port) {
        if (this.lastErrorMessage) {
            console.log(`[EmailReplyListener] IMAP connection restored to ${host}:${port}`);
            this.lastErrorMessage = null;
            this.lastErrorLogTime = 0;
        }
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.scheduleNext(false, 1000);
    }

    stop() {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.currentClient) {
            try {
                this.currentClient.logout().catch(() => {});
            } catch (_) {
                try {
                    this.currentClient.close();
                } catch (_) {}
            }
            this.currentClient = null;
        }
        this.isPolling = false;
    }

    scheduleNext(isError = false, overrideDelayMs = null) {
        if (!this.isRunning) return;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        let delayMs = this.pollIntervalMs;
        if (overrideDelayMs !== null) {
            delayMs = overrideDelayMs;
        } else if (isError) {
            this.consecutiveFailures++;
            delayMs = Math.min(300000, this.pollIntervalMs * Math.pow(1.5, Math.min(this.consecutiveFailures, 6)));
        } else {
            this.consecutiveFailures = 0;
        }

        this.timer = setTimeout(async () => {
            let hadError = false;
            try {
                const res = await this.pollInbox();
                hadError = !res?.success;
            } catch {
                hadError = true;
            } finally {
                this.scheduleNext(hadError);
            }
        }, delayMs);
    }

    async pollInbox() {
        if (this.isPolling || !this.isRunning) return { success: true };
        this.isPolling = true;

        const config = this.getConfig();
        if (!config.enabled) {
            this.isPolling = false;
            return { success: true, skipped: true };
        }

        if (isPlaceholder(config.user) || isPlaceholder(config.pass)) {
            this.logError("CONFIG", "IMAP credentials not configured or using placeholders in Backend/.env");
            this.isPolling = false;
            return { success: false, reason: "PLACEHOLDER_CREDENTIALS" };
        }

        try {
            await dns.promises.lookup(config.host, { family: 4 });
        } catch (dnsErr) {
            this.logError("DNS", `Cannot resolve IMAP host '${config.host}': ${dnsErr.message}`);
            this.isPolling = false;
            return { success: false, reason: "DNS_RESOLUTION_FAILED" };
        }

        const client = new ImapFlow({
            host: config.host,
            port: config.port,
            secure: config.secure,
            auth: {
                user: config.user,
                pass: config.pass,
            },
            logger: false,
            emitLogs: false,
            clientInfo: { name: "NovaAI", version: "1.0.0" },
            connectionTimeout: 15000,
            greetingTimeout: 10000,
            socketTimeout: 30000,
            tls: {
                rejectUnauthorized: false,
                servername: config.host,
            },
        });

        this.currentClient = client;
        let processedCount = 0;

        try {
            await client.connect();
            this.logRecovery(config.host, config.port);

            const lock = await client.getMailboxLock("INBOX");
            try {
                const searchSeqs = await client.search({ seen: false });
                let targetSeqs = [];
                if (Array.isArray(searchSeqs) && searchSeqs.length > 0) {
                    targetSeqs = searchSeqs.slice(-15).reverse();
                } else if (client.mailbox?.exists > 0) {
                    const total = client.mailbox.exists;
                    const count = Math.min(5, total);
                    for (let i = 0; i < count; i++) {
                        targetSeqs.push(total - i);
                    }
                }

                for (const seq of targetSeqs) {
                    try {
                        const msg = await client.fetchOne(seq, { uid: true, envelope: true, source: true });
                        if (!msg) continue;

                        const parsed = await simpleParser(msg.source);
                        const messageId = parsed.messageId || `${msg.uid}_${parsed.date?.getTime() || Date.now()}`;
                        if (this.processedMessageIds.has(messageId)) {
                            continue;
                        }

                        const existingRows = await query(
                            "SELECT id FROM lead_events WHERE event_type = 'EMAIL_REPLY_RECEIVED' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.messageId')) = ? LIMIT 1",
                            [messageId]
                        );
                        if (existingRows && existingRows.length > 0) {
                            this.processedMessageIds.add(messageId);
                            continue;
                        }

                        const fromAddress = extractEmailAddress(parsed.from?.value?.[0]?.address || parsed.from?.text || "");
                        const toAddress = extractEmailAddress(parsed.to?.value?.[0]?.address || parsed.to?.text || "");
                        const subject = parsed.subject || "";
                        const fullText = parsed.text || parsed.html || "";
                        const cleanBody = extractCleanReply(fullText);
                        const inReplyTo = parsed.inReplyTo || null;
                        const rawRefs = parsed.references;
                        const references = Array.isArray(rawRefs) ? rawRefs : (typeof rawRefs === "string" ? [rawRefs] : []);

                        if (fromAddress && fromAddress !== config.user.toLowerCase()) {
                            const result = await this.handleIncomingReply({
                                from: fromAddress,
                                to: toAddress,
                                subject,
                                body: cleanBody,
                                rawText: fullText,
                                messageId,
                                inReplyTo,
                                references,
                                date: parsed.date || new Date(),
                            });
                            if (result?.processed) {
                                processedCount++;
                            }
                        }

                        this.processedMessageIds.add(messageId);
                        try {
                            await client.messageFlagsAdd({ uid: msg.uid }, ["\\Seen"]);
                        } catch {}
                    } catch (msgErr) {
                        this.logError("MESSAGE", `Error processing message: ${msgErr.message}`);
                    }
                }
            } finally {
                lock.release();
            }

            try {
                await client.logout();
            } catch (_) {
                try {
                    client.close();
                } catch (_) {}
            }

            this.currentClient = null;
            return { success: true, processedCount };
        } catch (err) {
            const msg = String(err.message || "");
            if (msg.includes("Command failed") || err.authenticationFailed || err.responseStatus === "NO") {
                this.logError("AUTH", `Authentication failed for user '${config.user}'. Check mailbox credentials in Backend/.env`);
            } else if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
                this.logError("DNS", `Could not resolve '${config.host}': ${err.message}`);
            } else if (err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED") {
                this.logError("NETWORK", `Connection timeout/refused on ${config.host}:${config.port}: ${err.message}`);
            } else {
                this.logError("IMAP", `Connection error on ${config.host}:${config.port}: ${msg}`);
            }

            try {
                client.close();
            } catch (_) {}
            this.currentClient = null;
            return { success: false, error: msg };
        } finally {
            this.isPolling = false;
        }
    }

    async handleIncomingReply({ from, to = null, subject, body, rawText, messageId, inReplyTo = null, references = [], date = new Date() }) {
        const cleanFrom = extractEmailAddress(from);
        if (!cleanFrom) return null;

        const match = await followUpEngine.matchIncomingReply({
            from: cleanFrom,
            to,
            subject,
            messageId,
            inReplyTo,
            references,
        });

        if (match.ambiguous) {
            await LeadEvent.create({
                organization_id: 1,
                lead_id: match.candidateIds?.[0] || 1,
                channel: "EMAIL",
                event_type: "REPLY_MATCH_AMBIGUOUS",
                status: "REVIEW_REQUIRED",
                payload: {
                    from: cleanFrom,
                    subject,
                    messageId,
                    candidateIds: match.candidateIds,
                    reason: match.reason,
                },
                idempotency_key: `ambiguous_reply_${messageId || Date.now()}`,
            });
            return { processed: true, ambiguous: true };
        }

        let lead = match.lead;
        if (!lead) {
            const leads = await query(
                `SELECT * FROM leads WHERE LOWER(email) = ? ORDER BY id DESC LIMIT 1`,
                [cleanFrom]
            );
            if (leads && leads.length > 0) {
                lead = leads[0];
            }
        }

        if (!lead) return null;
        const orgId = Number(lead.organization_id || 1);

        const outcome = normalizeChannelOutcome("EMAIL", {
            reply: body,
            transcript: body,
            subject,
        });

        await OrchestratorService.handleOutcomeEvent(lead, outcome, {
            channel: "EMAIL",
            replyText: body,
            subject,
            from: cleanFrom,
            messageId,
            receivedAt: (date instanceof Date ? date : new Date(date)).toISOString(),
        });

        let enrollment = match.enrollment;
        if (!enrollment) {
            enrollment = await FollowUpEnrollment.findActiveByLeadId(lead.id, orgId);
        }
        if (enrollment) {
            try {
                await followUpEngine.handleLeadReply(
                    lead,
                    {
                        outcome,
                        subject,
                        replyText: body,
                        messageId,
                        inReplyTo,
                        references,
                        date,
                    },
                    enrollment
                );
            } catch (err) {
                this.logError("FOLLOWUP", `Error handling follow-up lead reply: ${err.message}`);
            }
        }

        if (outcome === ASE_OUTCOMES.DNC) {
            await followUpEngine.handleSuppression(lead.id, orgId).catch(() => {});
        }

        const currentScore = Number(lead.priority || 50);
        const scoreBonus = outcome === ASE_OUTCOMES.INTERESTED ? 35 : (outcome === ASE_OUTCOMES.CALLBACK ? 25 : 10);
        const newScore = Math.min(100, currentScore + scoreBonus);

        await Lead.updateById(
            lead.id,
            {
                priority: newScore,
                last_contacted_at: new Date(),
            },
            orgId
        );

        await LeadEvent.create({
            organization_id: orgId,
            lead_id: lead.id,
            user_id: lead.user_id || null,
            channel: "EMAIL",
            event_type: "EMAIL_REPLY_RECEIVED",
            status: outcome,
            payload: {
                from: cleanFrom,
                to,
                subject,
                replyText: body,
                outcome,
                messageId,
                inReplyTo,
                matchedBy: match.matchedBy || "SENDER_EMAIL",
                receivedAt: (date instanceof Date ? date : new Date(date)).toISOString(),
            },
            idempotency_key: `lead_${lead.id}_reply_${messageId || Date.now()}`,
        });

        const io = getIo();
        if (io) {
            io.emit("lead:reply_received", {
                leadId: lead.id,
                email: lead.email,
                name: lead.name,
                replyText: body,
                outcome,
                subject,
                matchedBy: match.matchedBy,
            });
            io.emit("lead:updated", { id: lead.id });
        }

        return {
            processed: true,
            leadId: lead.id,
            outcome,
            matchedBy: match.matchedBy,
        };
    }
}

export const emailReplyListener = new EmailReplyListenerService();

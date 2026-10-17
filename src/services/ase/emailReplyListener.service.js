import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { query } from "../../config/db.js";
import { Lead } from "../../models/lead.model.js";
import { LeadEvent } from "../../models/lead-event.model.js";
import { OrchestratorService } from "./orchestrator.service.js";
import { normalizeChannelOutcome, ASE_OUTCOMES } from "./outcomeNormalizer.service.js";
import { getIo } from "../../socket/socketServer.js";

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

class EmailReplyListenerService {
    constructor() {
        this.pollIntervalMs = 15000;
        this.timer = null;
        this.isPolling = false;
        this.isRunning = false;
        this.processedMessageIds = new Set();
    }

    getConfig() {
        const host = process.env.IMAP_HOST || (process.env.SMTP_HOST ? process.env.SMTP_HOST.replace(/^smtp\./i, "imap.") : "imap.hostinger.com");
        const port = Number(process.env.IMAP_PORT || 993);
        const user = process.env.IMAP_USER || process.env.SMTP_USER || "nova@evokeaisolutions.com";
        const pass = process.env.IMAP_PASS || process.env.SMTP_PASS || "Nova@1200";
        return { host, port, user, pass };
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.scheduleNext(1000);
    }

    stop() {
        this.isRunning = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    scheduleNext(delayMs = this.pollIntervalMs) {
        if (!this.isRunning) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.pollInbox().finally(() => {
                this.scheduleNext();
            });
        }, delayMs);
    }

    async pollInbox() {
        if (this.isPolling) return;
        this.isPolling = true;

        const config = this.getConfig();
        if (!config.user || !config.pass) {
            this.isPolling = false;
            return;
        }

        const client = new ImapFlow({
            host: config.host,
            port: config.port,
            secure: config.port === 993,
            auth: {
                user: config.user,
                pass: config.pass,
            },
            logger: false,
            emitLogs: false,
        });

        let processedCount = 0;
        try {
            await client.connect();
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
                        const subject = parsed.subject || "";
                        const fullText = parsed.text || parsed.html || "";
                        const cleanBody = extractCleanReply(fullText);

                        if (fromAddress && fromAddress !== config.user.toLowerCase()) {
                            const result = await this.handleIncomingReply({
                                from: fromAddress,
                                subject,
                                body: cleanBody,
                                rawText: fullText,
                                messageId,
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
                        console.error("[EmailReplyListener] Message processing error:", msgErr.message);
                    }
                }
            } finally {
                lock.release();
            }
            await client.logout();
        } catch (err) {
            console.error("[EmailReplyListener] IMAP polling error:", err.message);
        } finally {
            this.isPolling = false;
        }
        return { success: true, processedCount };
    }

    async handleIncomingReply({ from, subject, body, rawText, messageId, date = new Date() }) {
        const cleanFrom = extractEmailAddress(from);
        if (!cleanFrom) return null;

        const leads = await query(
            `SELECT * FROM leads WHERE LOWER(email) = ? ORDER BY id DESC LIMIT 1`,
            [cleanFrom]
        );

        if (!leads || leads.length === 0) {
            return null;
        }

        const lead = leads[0];
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
                subject,
                replyText: body,
                outcome,
                messageId,
                receivedAt: (date instanceof Date ? date : new Date(date)).toISOString(),
            },
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
            });
            io.emit("lead:updated", { id: lead.id });
        }

        return {
            processed: true,
            leadId: lead.id,
            outcome,
        };
    }
}

export const emailReplyListener = new EmailReplyListenerService();

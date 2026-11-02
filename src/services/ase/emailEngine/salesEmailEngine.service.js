import { getOpenAiClient } from "../../../controllers/OpenAI/client.js";
import { Suppression } from "../../../models/suppression.model.js";
import { LeadEvent } from "../../../models/lead-event.model.js";
import { bodyToHtml, formatFirstName, sanitizeOutreachEmail, stripSignoff } from "../../../utils/outreachEmail.js";
import { isUsableResearchProfile, researchCompany } from "../companyResearch.service.js";
import { consentForAction } from "../consent.service.js";
import { analyzeContactRole } from "./contactRole.js";
import { analyzeIndustry } from "./industryContext.js";
import { buildResearchContext, RESEARCH_STRENGTH, evidenceById } from "./researchContext.js";
import { buildProductKnowledge, resolveProductKnowledge } from "./productKnowledge.js";
import { CONVERSATION_STAGES, loadCommunicationHistory, summarizeHistory } from "./communicationHistory.js";
import { buildPersonalizationStrategy } from "./personalizationStrategy.js";
import { buildSystemPrompt, buildUserPrompt } from "./emailPrompt.js";
import { composeFallbackEmail } from "./emailComposer.js";
import { CONVERSATION_BLOCKERS, MIN_ACCEPTABLE_SCORE, scoreEmail, usedFactRefs } from "./emailScoring.js";
import { buildFingerprint, checkSimilarity, normalizeForComparison } from "./emailSimilarity.js";

export const GENERATION_VERSION = "nova-sales-email/2.1";

export const GENERATION_STATUS = Object.freeze({
    READY: "READY",
    NEEDS_REVIEW: "NEEDS_REVIEW",
    FAILED_VALIDATION: "FAILED_VALIDATION",
    BLOCKED_COMPLIANCE: "BLOCKED_COMPLIANCE",
});

const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "proton.me", "protonmail.com", "aol.com", "live.com"]);
const CLOSED_STATUSES = new Set(["CLOSED_WON", "CLOSED_LOST", "CLOSED_UNQUALIFIED"]);
const SIMILARITY_RETRY_ISSUES = new Set(["NEAR_DUPLICATE_OF_PREVIOUS_EMAIL", "SIMILAR_TO_PREVIOUS_EMAIL", "IDENTICAL_BODY_ACROSS_LEADS", "REPEATED_OPENING", "REPEATED_SUBJECT", "REPEATED_VALUE_PROPOSITION", "NEAR_DUPLICATE_ACROSS_LEADS", "REPEATED_OPENING_ACROSS_LEADS"]);
const MAX_HISTORY_ENTRIES = 5;

function maxAttempts() {
    const value = Number(process.env.ASE_EMAIL_MAX_ATTEMPTS || 3);
    return Math.min(Math.max(Number.isFinite(value) ? value : 3, 1), 5);
}

export function readLeadMetadata(lead) {
    if (!lead?.metadata) return {};
    if (typeof lead.metadata === "object") return lead.metadata;
    try {
        return JSON.parse(lead.metadata);
    } catch {
        return {};
    }
}

export function resolveLeadIdentity(lead = {}) {
    const emailDomain = lead.email ? String(lead.email).split("@")[1]?.toLowerCase() || "" : "";
    const domainCompany = emailDomain && !FREE_MAIL.has(emailDomain)
        ? emailDomain.split(".")[0].replace(/[-_]/g, " ")
        : "";
    const company = String(lead.company || "").trim()
        || (domainCompany ? domainCompany.charAt(0).toUpperCase() + domainCompany.slice(1) : "your company");
    const rawFirst = lead.first_name || (lead.name ? String(lead.name).trim().split(/\s+/)[0] : "");
    const firstName = /^[\p{L}][\p{L}'-]{0,40}$/u.test(String(rawFirst || "").trim()) ? formatFirstName(rawFirst) : "there";
    return {
        firstName,
        lastName: String(lead.last_name || "").trim() || null,
        company,
        companyKnown: Boolean(lead.company || domainCompany),
        emailDomain: FREE_MAIL.has(emailDomain) ? null : emailDomain || null,
    };
}

export function evaluateGenerationCompliance(lead, { suppressed = false, stage = null } = {}) {
    if (!lead) return { allowed: false, reason: "LEAD_NOT_FOUND", message: "Lead not found" };
    const status = String(lead.status || "").toUpperCase();
    if (lead.do_not_contact) return { allowed: false, reason: "DO_NOT_CONTACT", message: "Lead is marked Do Not Contact" };
    if (status === "SUPPRESSED_DNC") return { allowed: false, reason: "SUPPRESSED", message: "Lead is suppressed" };
    if (suppressed) return { allowed: false, reason: "SUPPRESSION_LIST", message: "Lead matches the suppression list" };
    const consent = consentForAction(lead, "EMAIL");
    const consentStatus = String(typeof consent === "string" ? consent : consent?.status || "").toUpperCase();
    if (["DENIED", "REVOKED", "WITHDRAWN", "OPTED_OUT"].includes(consentStatus)) {
        return { allowed: false, reason: "EMAIL_CONSENT_DENIED", message: "Email consent has been denied" };
    }
    if (stage === CONVERSATION_STAGES.OPTED_OUT) return { allowed: false, reason: "OPTED_OUT", message: "Prospect opted out of email" };
    if (stage === CONVERSATION_STAGES.HUMAN_REQUIRED) return { allowed: false, reason: "HUMAN_REPLY_REQUIRED", message: "Latest reply needs a human-written response" };
    if (CLOSED_STATUSES.has(status)) return { allowed: false, reason: "LEAD_CLOSED", message: `Lead is ${status}` };
    const warnings = consentStatus === "GRANTED" ? [] : ["EMAIL_CONSENT_NOT_GRANTED"];
    return { allowed: true, warnings };
}

export async function loadOrgRecentFingerprints(orgId, leadId) {
    try {
        const rows = await LeadEvent.listRecentPayloadsByType(orgId, "EMAIL_DRAFTED", { excludeLeadId: leadId, limit: 60 });
        return rows.map((row) => row.payload?.fingerprint).filter((item) => item && typeof item === "object");
    } catch {
        return [];
    }
}

async function resolveResearch(lead, identity, meta, options) {
    if (options.research !== undefined) return options.research;
    if (isUsableResearchProfile(meta.company_research)) return meta.company_research;
    if (options.skipResearchFetch || !identity.companyKnown) return meta.company_research || null;
    try {
        return await researchCompany(identity.company, { domain: identity.emailDomain, leadInfo: lead });
    } catch (err) {
        console.warn(`[EmailEngine] research lookup failed for lead ${lead.id}: ${err.message}`);
        return meta.company_research || null;
    }
}

export async function resolveEmailContext(lead, options = {}) {
    const orgId = Number(lead?.organization_id || 1);
    const meta = readLeadMetadata(lead);
    const identity = resolveLeadIdentity(lead);
    const domain = lead?.email ? String(lead.email).split("@")[1] : null;
    const [suppressed, knowledge, history, orgRecent] = await Promise.all([
        options.suppressed !== undefined
            ? options.suppressed
            : Suppression.isSuppressed(orgId, { email: lead?.email, phone: lead?.phone, domain }).catch(() => false),
        options.knowledge || resolveProductKnowledge(orgId, { senderName: options.senderName || null }),
        options.history || loadCommunicationHistory(lead, { sentOutreach: meta.outreach_email_history || [] }),
        options.orgRecent || loadOrgRecentFingerprints(orgId, lead?.id),
    ]);
    const compliance = evaluateGenerationCompliance(lead, { suppressed: Boolean(suppressed), stage: history.stage });
    const base = { lead, orgId, meta, ...identity, knowledge, history, orgRecent, compliance, campaign: options.campaign || null };
    if (!compliance.allowed) return { ...base, blocked: true };

    const rawResearch = await resolveResearch(lead, identity, meta, options);
    const research = buildResearchContext(rawResearch, { company: identity.company });
    const role = analyzeContactRole(lead);
    const industry = analyzeIndustry(lead, research);
    return { ...base, blocked: false, rawResearch, research, role, industry };
}

function parseModelDraft(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw || "{}");
    } catch {
        return null;
    }
    const subject = String(parsed.subject || "").replace(/\s+/g, " ").trim();
    let paragraphs = Array.isArray(parsed.paragraphs)
        ? parsed.paragraphs.map((item) => String(item || "").trim()).filter(Boolean)
        : String(parsed.body || parsed.text || "").split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
    let cta = String(parsed.cta || "").trim();
    paragraphs = paragraphs
        .filter((item) => !/^(hi|hello|dear)\b[^\n]{0,40},?$/i.test(item))
        .map((item) => stripSignoff(item))
        .filter(Boolean);
    if (!cta && paragraphs.length && /\?\s*$/.test(paragraphs[paragraphs.length - 1])) cta = paragraphs.pop();
    if (cta && paragraphs.length && paragraphs[paragraphs.length - 1] === cta) paragraphs.pop();
    if (!subject || !paragraphs.length) return null;
    return {
        subject,
        paragraphs: paragraphs.slice(0, 5),
        cta,
        factRefs: Array.isArray(parsed.factRefs) ? parsed.factRefs.map(String).slice(0, 8) : [],
        capabilitiesUsed: Array.isArray(parsed.capabilitiesUsed) ? parsed.capabilitiesUsed.map(String).slice(0, 5) : [],
        detectedIndustry: parsed.detectedIndustry ? String(parsed.detectedIndustry).slice(0, 80) : null,
        personalizationReason: parsed.personalizationReason ? String(parsed.personalizationReason).slice(0, 400) : null,
        needsHumanInput: [],
    };
}

async function generateWithModel(client, context, strategy, feedback, attempt) {
    const completion = await client.chat.completions.create({
        model: process.env.ASE_EMAIL_MODEL || process.env.ASE_RESEARCH_MODEL || "gpt-4o-mini",
        temperature: Math.min(0.55 + attempt * 0.1, 0.85),
        response_format: { type: "json_object" },
        messages: [
            { role: "system", content: buildSystemPrompt(context) },
            { role: "user", content: buildUserPrompt({ ...context, strategy, feedback }) },
        ],
    });
    return parseModelDraft(completion.choices?.[0]?.message?.content);
}

function signatureFor(knowledge) {
    const sender = knowledge.senderName || knowledge.brandName;
    return knowledge.brandName && knowledge.brandName.toLowerCase() !== String(sender).toLowerCase()
        ? `${sender}\n${knowledge.brandName}`
        : sender;
}

function evaluateCandidate(draft, context, strategy, generator) {
    const greeting = `Hi ${context.firstName},`;
    const body = [...draft.paragraphs, draft.cta].filter(Boolean).join("\n\n");
    const cleaned = sanitizeOutreachEmail({ subject: draft.subject, text: `${greeting}\n\n${body}` }, signatureFor(context.knowledge));
    const similarity = checkSimilarity({ subject: cleaned.subject, text: cleaned.text }, {
        firstName: context.firstName,
        company: context.company,
        history: context.history,
        orgRecent: context.orgRecent,
        capabilitiesUsed: draft.capabilitiesUsed,
        stage: strategy.stage,
    });
    const quality = scoreEmail({ ...draft, greeting, subject: cleaned.subject, text: cleaned.text }, { ...context, strategy });
    const retryIssues = [
        ...quality.conversationIssues.filter((issue) => CONVERSATION_BLOCKERS.has(issue)),
        ...similarity.issues.filter((issue) => SIMILARITY_RETRY_ISSUES.has(issue)),
    ];
    const acceptable = quality.hardGate.passed && quality.score >= MIN_ACCEPTABLE_SCORE && !retryIssues.length && !draft.needsHumanInput?.length;
    return { draft: { ...draft, greeting }, email: cleaned, quality, similarity, strategy, generator, retryIssues, acceptable };
}

function rank(candidate) {
    return (candidate.quality.hardGate.passed ? 1000 : 0)
        + (candidate.similarity.blocking ? 0 : 200)
        + (candidate.retryIssues.length ? 0 : 100)
        + candidate.quality.score;
}

function feedbackFor(candidate) {
    const notes = [];
    for (const failure of candidate.quality.hardGate.failures) notes.push(`Hard validation failed: ${failure}`);
    for (const issue of candidate.retryIssues) notes.push(`Repetition or context problem: ${issue}`);
    if (candidate.quality.score < MIN_ACCEPTABLE_SCORE) {
        notes.push(`Quality score ${candidate.quality.score}/100. Weak areas: ${Object.entries(candidate.quality.breakdown)
            .filter(([, value]) => value.score < value.max * 0.6)
            .map(([key]) => key)
            .join(", ") || "general"}`);
    }
    for (const warning of candidate.quality.warnings.slice(0, 6)) notes.push(`Warning: ${warning}`);
    return notes;
}

function statusFor(candidate, context) {
    if (!candidate.quality.hardGate.passed) return GENERATION_STATUS.FAILED_VALIDATION;
    if (!candidate.acceptable || candidate.similarity.blocking) return GENERATION_STATUS.NEEDS_REVIEW;
    const firstTouch = [CONVERSATION_STAGES.FIRST_OUTREACH, CONVERSATION_STAGES.FOLLOW_UP_NO_REPLY].includes(candidate.strategy.stage);
    if (firstTouch && context.research.strength === RESEARCH_STRENGTH.NONE) return GENERATION_STATUS.NEEDS_REVIEW;
    return GENERATION_STATUS.READY;
}

function blockedResult(context) {
    return {
        blocked: true,
        block_reason: context.compliance.reason,
        block_message: context.compliance.message,
        subject: "",
        text: "",
        html: "",
        generation_version: GENERATION_VERSION,
        generation_status: GENERATION_STATUS.BLOCKED_COMPLIANCE,
        conversation_context: conversationContext(context.history),
        qualityChecks: { factualGrounding: "blocked", complianceCheck: "failed", duplicateCheck: "pending", issues: [context.compliance.reason], eligibleToSend: false },
        research: context.meta?.company_research || null,
    };
}

function conversationContext(history) {
    return {
        stage: history.stage,
        outboundCount: history.outboundCount,
        inboundCount: history.inboundCount,
        followUpCount: history.followUpCount,
        lastInteractionAt: history.lastInteractionAt,
        latestInboundIntent: history.latestInbound?.intent || null,
        callsConnected: history.callsConnected,
    };
}

export function formatEngineResult(candidate, context, { attempts = [] } = {}) {
    const { quality, similarity, strategy, draft, email } = candidate;
    const status = statusFor(candidate, context);
    const evidence = evidenceById(context.research);
    const body = [...draft.paragraphs, draft.cta].filter(Boolean).join("\n\n");
    const usedRefs = usedFactRefs(draft, body, context.research);
    const warnings = [...new Set([
        ...(context.compliance.warnings || []),
        ...quality.warnings,
        ...similarity.issues,
        ...(draft.needsHumanInput?.length ? ["NEEDS_HUMAN_INPUT"] : []),
        ...(context.research.strength === RESEARCH_STRENGTH.NONE ? ["INSUFFICIENT_RESEARCH"] : []),
        ...(context.research.disputed?.length ? ["DISPUTED_FACTS_EXCLUDED"] : []),
    ])];
    const fingerprint = {
        ...buildFingerprint({ subject: email.subject, text: email.text }, {
            firstName: context.firstName,
            company: context.company,
            angle: strategy.angle,
            ctaStyle: strategy.ctaStyle,
            capabilities: draft.capabilitiesUsed,
        }),
        bodyNormalized: normalizeForComparison(email.text, { firstName: context.firstName, company: context.company }).slice(0, 600),
    };
    return {
        blocked: false,
        subject: email.subject,
        text: email.text,
        html: email.html || bodyToHtml(email.text),
        greeting: draft.greeting,
        research: context.rawResearch || null,
        generator: candidate.generator,
        attempts: attempts.length,
        generation_version: GENERATION_VERSION,
        generation_status: status,
        quality_score: quality.score,
        quality_band: quality.band,
        quality_breakdown: quality.breakdown,
        validation_warnings: warnings,
        hard_gate: { passed: quality.hardGate.passed, failures: quality.hardGate.failures },
        similarity_score: similarity.similarityScore,
        similarity: { lead: similarity.leadSimilarity, org: similarity.orgSimilarity, issues: similarity.issues },
        needs_human_input: draft.needsHumanInput || [],
        personalization_context: {
            stage: strategy.stage,
            angle: strategy.angle,
            persona: context.role.persona,
            openingStyle: strategy.openingStyle,
            ctaStyle: strategy.ctaStyle,
            researchStrength: context.research.strength,
            capabilities: strategy.capabilities.map((capability) => ({ key: capability.key, name: capability.name })),
            reason: draft.personalizationReason || strategy.personalizationReason,
            productSource: context.knowledge.source,
            playbookVersion: context.knowledge.playbookVersion,
        },
        industry_context: {
            key: context.industry.key,
            label: context.industry.label,
            subIndustry: context.industry.subIndustry,
            verified: context.industry.verified,
            source: context.industry.source,
            confidence: context.industry.confidence,
            opportunity: context.industry.opportunity,
            modelDetected: draft.detectedIndustry || null,
        },
        research_fact_references: usedRefs.map((ref) => evidence.get(ref)),
        research_evidence: [...context.research.facts, ...context.research.signals].slice(0, 8),
        inferred_personalization: context.research.inferred,
        disputed_facts: context.research.disputed || [],
        research_sources: context.research.sources,
        contact_role_context: {
            title: context.role.title,
            department: context.role.department,
            persona: context.role.persona,
            label: context.role.label,
            focusAreas: context.role.focusAreas,
            titleKnown: context.role.titleKnown,
        },
        conversation_context: conversationContext(context.history),
        fingerprint,
        qualityChecks: {
            factualGrounding: quality.hardGate.passed ? (context.research.grounded ? "passed" : "conservative") : "failed",
            duplicateCheck: similarity.issues.length ? "warning" : "passed",
            complianceCheck: "passed",
            issues: quality.hardGate.failures,
            eligibleToSend: status === GENERATION_STATUS.READY,
            qualityStatus: context.research.qualityStatus,
            maxSimilarity: similarity.similarityScore,
        },
    };
}

export async function composeSalesEmail(context, { client = null, attemptsLimit = maxAttempts() } = {}) {
    if (context.blocked) return blockedResult(context);
    const attempts = [];
    let best = null;
    let feedback = [];

    if (client) {
        for (let attempt = 0; attempt < attemptsLimit; attempt += 1) {
            const strategy = buildPersonalizationStrategy({ ...context, attempt });
            try {
                const draft = await generateWithModel(client, context, strategy, feedback, attempt);
                if (!draft) {
                    attempts.push({ attempt, generator: "openai", error: "UNPARSEABLE_RESPONSE" });
                    continue;
                }
                const candidate = evaluateCandidate(draft, context, strategy, "openai");
                attempts.push({ attempt, generator: "openai", score: candidate.quality.score, failures: candidate.quality.hardGate.failures, retryIssues: candidate.retryIssues });
                if (!best || rank(candidate) > rank(best)) best = candidate;
                if (candidate.acceptable) break;
                feedback = feedbackFor(candidate);
            } catch (err) {
                attempts.push({ attempt, generator: "openai", error: err.message });
                console.warn(`[EmailEngine] model attempt ${attempt + 1} failed for lead ${context.lead?.id}: ${err.message}`);
            }
        }
    }

    if (!best?.acceptable) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const strategy = buildPersonalizationStrategy({ ...context, attempt: attempt + 10 });
            const candidate = evaluateCandidate(composeFallbackEmail({ ...context, strategy }), context, strategy, "composer");
            attempts.push({ attempt, generator: "composer", score: candidate.quality.score, failures: candidate.quality.hardGate.failures });
            if (!best || rank(candidate) > rank(best)) best = candidate;
            if (candidate.acceptable) break;
        }
    }

    const result = formatEngineResult(best, context, { attempts });
    console.info(`[EmailEngine] lead=${context.lead?.id || "new"} stage=${result.personalization_context.stage} status=${result.generation_status} score=${result.quality_score} generator=${result.generator} attempts=${attempts.length}`);
    return result;
}

export async function generateSalesEmail(lead, options = {}) {
    const context = await resolveEmailContext(lead, options);
    const client = options.client !== undefined ? options.client : getOpenAiClient();
    return composeSalesEmail(context, { client });
}

function draftFromText(subject, text) {
    const parts = stripSignoff(String(text || "")).split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    const greeting = parts[0] && /^(hi|hello|dear)\b/i.test(parts[0]) ? parts.shift() : "";
    const cta = parts.length && /\?\s*\)?\s*$/.test(parts[parts.length - 1]) ? parts.pop() : "";
    return { subject: String(subject || "").trim(), greeting, paragraphs: parts, cta, factRefs: [], capabilitiesUsed: [], needsHumanInput: [] };
}

export async function rescoreEditedEmail(lead, { subject, text }, options = {}) {
    const meta = readLeadMetadata(lead);
    const context = await resolveEmailContext(lead, { ...options, skipResearchFetch: true, research: options.research ?? meta.company_research ?? null });
    if (context.blocked) return blockedResult(context);
    const strategy = buildPersonalizationStrategy({ ...context, attempt: 0 });
    const draft = draftFromText(subject, text);
    draft.factRefs = (meta.outreach_email?.research_fact_references || []).map((item) => item?.id).filter(Boolean);
    const candidate = evaluateCandidate(draft, context, strategy, "human_edit");
    const result = formatEngineResult(candidate, context);
    if (result.generation_status === GENERATION_STATUS.NEEDS_REVIEW || result.generation_status === GENERATION_STATUS.READY) {
        result.generation_status = GENERATION_STATUS.NEEDS_REVIEW;
    }
    return result;
}

export function buildOfflineContext({ lead, research = null, playbook = null, previousBodies = [], senderName = null }) {
    const identity = resolveLeadIdentity(lead);
    const researchContext = buildResearchContext(research, { company: identity.company });
    const now = Date.now();
    const items = previousBodies.map((text, index) => ({ direction: "OUTBOUND", subject: "", text: String(text || ""), at: new Date(now - (previousBodies.length - index) * 3600 * 1000).toISOString() }));
    const history = summarizeHistory({ lead, items });
    return {
        lead,
        ...identity,
        knowledge: buildProductKnowledge(playbook, { senderName }),
        history,
        orgRecent: [],
        compliance: { allowed: true, warnings: [] },
        research: researchContext,
        rawResearch: research,
        role: analyzeContactRole(lead),
        industry: analyzeIndustry(lead, researchContext),
        blocked: false,
    };
}

export function scoreExternalDraft(context, { subject, text }) {
    const strategy = buildPersonalizationStrategy({ ...context, attempt: 0 });
    const candidate = evaluateCandidate(draftFromText(subject, text), context, strategy, "external");
    return {
        quality_score: candidate.quality.score,
        quality_band: candidate.quality.band,
        quality_breakdown: candidate.quality.breakdown,
        validation_warnings: [...candidate.quality.warnings, ...candidate.similarity.issues],
        hard_gate: { passed: candidate.quality.hardGate.passed, failures: candidate.quality.hardGate.failures },
        industry: context.industry.label,
        persona: context.role.label,
    };
}

export function toStoredOutreachEmail(result, { previous = null, edited = false, userId = null } = {}) {
    const now = new Date().toISOString();
    return {
        subject: result.subject,
        text: result.text,
        html: result.html,
        written_at: edited ? (previous?.written_at || now) : now,
        updated_at: now,
        is_edited: Boolean(edited),
        edited_by: edited ? userId : null,
        edited_at: edited ? now : null,
        generator: result.generator,
        generation_version: result.generation_version,
        generation_status: result.generation_status,
        quality_score: result.quality_score,
        quality_band: result.quality_band,
        quality_breakdown: result.quality_breakdown,
        validation_warnings: result.validation_warnings,
        hard_gate: result.hard_gate,
        similarity_score: result.similarity_score,
        personalization_context: result.personalization_context,
        industry_context: result.industry_context,
        research_fact_references: result.research_fact_references,
        research_evidence: result.research_evidence,
        inferred_personalization: result.inferred_personalization,
        research_sources: result.research_sources,
        contact_role_context: result.contact_role_context,
        conversation_context: result.conversation_context,
        needs_human_input: result.needs_human_input,
        fingerprint: { ...result.fingerprint, bodyNormalized: undefined },
        qualityChecks: result.qualityChecks,
        approvalStatus: "pending",
        approved_by: null,
        approved_at: null,
    };
}

export function draftedEventPayload(result, company) {
    return {
        subject: result.subject,
        company,
        generation_version: result.generation_version,
        generation_status: result.generation_status,
        quality_score: result.quality_score,
        stage: result.personalization_context?.stage || null,
        fingerprint: result.fingerprint,
    };
}

export function isSendableDraft(email, { approved = false } = {}) {
    if (!email?.subject || !(email.text || email.html)) return { sendable: false, reason: "NO_DRAFT" };
    if (email.sent_at) return { sendable: false, reason: "ALREADY_SENT" };
    if (email.hard_gate && email.hard_gate.passed === false) return { sendable: false, reason: "FAILED_VALIDATION", reviewRequired: true };
    if (!email.generation_version) return { sendable: true };
    if (email.approvalStatus === "approved" || approved) return { sendable: true };
    if (email.generation_status === GENERATION_STATUS.READY) return { sendable: true };
    return { sendable: false, reason: email.generation_status || "NEEDS_REVIEW", reviewRequired: true };
}

export function recordSentOutreach(meta, email, { sentAt = new Date() } = {}) {
    const sentIso = new Date(sentAt).toISOString();
    const entry = {
        subject: email.subject,
        text: String(email.text || "").slice(0, 500),
        sent_at: sentIso,
        angle: email.personalization_context?.angle || null,
        capabilities: (email.personalization_context?.capabilities || []).map((item) => item.key),
        hook: (email.research_fact_references || [])[0]?.value || null,
        stage: email.personalization_context?.stage || null,
    };
    return {
        ...meta,
        outreach_email: { ...email, sent_at: sentIso, approvalStatus: email.approvalStatus === "pending" ? "sent" : email.approvalStatus },
        outreach_email_history: [...(meta.outreach_email_history || []), entry].slice(-MAX_HISTORY_ENTRIES),
    };
}

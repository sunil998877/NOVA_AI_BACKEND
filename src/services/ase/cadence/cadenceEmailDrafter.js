import { getOpenAiClient } from "../../../controllers/OpenAI/client.js";
import { env } from "../../../config/env.js";
import { bodyToHtml, formatFirstName, sanitizeOutreachEmail } from "../../../utils/outreachEmail.js";
import { validateEmailDraft } from "../emailQuality.service.js";
import { getActivePlaybook, playbookFactsForAi } from "../salesPlaybook.service.js";
import { isUsableResearchProfile, researchCompany } from "../companyResearch.service.js";
import { STEP_PURPOSE } from "./cadence.constants.js";

const GROUNDED_QUALITY = new Set(["HIGH_CONFIDENCE", "ACCEPTABLE", "PARTIAL_RESEARCH"]);
const PURPOSE_BRIEF = {
    [STEP_PURPOSE.MISSED_CALL_EMAIL]: "We called and could not reach the prospect. Say plainly that we tried to call and could not connect. Never imply any conversation happened. Give one short reason the call was relevant, then ask for a convenient time.",
    [STEP_PURPOSE.VALUE_EMAIL]: "Share one specific, relevant value point from the seller facts that fits the prospect's business. Do not repeat earlier emails. Ask one low-friction question.",
    [STEP_PURPOSE.INSIGHT_EMAIL]: "Offer one observation grounded only in the verified research about the prospect, connected to a seller capability. Frame it as a question, not a claim.",
};

function readMetadata(lead) {
    if (!lead?.metadata) return {};
    if (typeof lead.metadata === "object") return lead.metadata;
    try {
        return JSON.parse(lead.metadata);
    } catch {
        return {};
    }
}

export function isGroundedResearch(research) {
    if (!isUsableResearchProfile(research)) return false;
    const hasSources = Array.isArray(research.sources) && research.sources.some((s) => s?.url);
    return hasSources && GROUNDED_QUALITY.has(String(research.qualityStatus || "").toUpperCase());
}

function firstSentence(text, max = 180) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return "";
    const match = /^(.+?[.!?])(\s|$)/.exec(clean);
    const sentence = match ? match[1] : clean;
    return sentence.length > max ? `${sentence.slice(0, max - 1).trim()}…` : sentence;
}

function lowerFirst(text) {
    return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

export function buildCadenceTemplate({ purpose, firstName, company, senderName, brandName, research, grounded, seller = {} }) {
    const name = formatFirstName(firstName);
    const brand = brandName || senderName;
    const offer = seller.productName || seller.productDescription || "";
    const value = Array.isArray(seller.valuePropositions) ? seller.valuePropositions[0] : "";
    const pain = Array.isArray(seller.painPoints) ? seller.painPoints[0] : "";
    const cta = seller.preferredCta || "Would a short call next week be useful?";
    const researchLine = grounded && research?.industry
        ? `I understand ${company} works in ${research.industry}.`
        : "";
    const signoff = `Best regards,\n${senderName}${brand && brand !== senderName ? `\n${brand}` : ""}`;

    let subject;
    let body;
    if (purpose === STEP_PURPOSE.MISSED_CALL_EMAIL) {
        subject = `Tried to reach you, ${name}`;
        const why = value
            ? `I wanted to briefly share how ${brand} helps teams with ${lowerFirst(value)}.`
            : `I wanted to briefly introduce ${brand}${offer ? ` and ${offer}` : ""}.`;
        body = [`Hi ${name},`, `I tried calling you today but could not reach you. ${researchLine} ${why}`.replace(/\s+/g, " ").trim(), `${cta} Feel free to reply with a time that suits you.`, signoff].join("\n\n");
    } else if (purpose === STEP_PURPOSE.INSIGHT_EMAIL) {
        subject = grounded && research?.industry ? `A question about ${company}'s ${research.industry} work` : `A question for ${company}`;
        const insight = grounded && research?.coreServices
            ? `Teams offering ${lowerFirst(firstSentence(research.coreServices, 120).replace(/[.!?]$/, ""))} often look at how they handle ${pain ? lowerFirst(pain) : "day-to-day operations"}.`
            : (pain ? `Many teams we speak with mention ${lowerFirst(pain)}.` : "I had one question about how your team approaches this today.");
        body = [`Hi ${name},`, `${insight} Is that something ${company} is thinking about right now?`, offer ? `If it is, ${brand} may be relevant through ${offer}. ${cta}` : cta, signoff].join("\n\n");
    } else {
        subject = value ? `${brand} for ${company}` : `A note for ${company}`;
        const lead = value
            ? `${brand} helps businesses with ${lowerFirst(value)}.`
            : `I am reaching out from ${brand}${offer ? ` about ${offer}` : ""}.`;
        body = [`Hi ${name},`, `${researchLine} ${lead}`.trim(), `If this is relevant for ${company}, ${lowerFirst(cta)}`, signoff].join("\n\n");
    }
    return { subject, text: body, html: bodyToHtml(body) };
}

async function writeWithAi({ client, purpose, firstName, company, senderName, brandName, research, grounded, seller, previousBodies }) {
    const facts = grounded
        ? `Verified prospect research (from ${research.sources.map((s) => s.url).slice(0, 3).join(", ")}):\nSummary: ${research.summary}\nIndustry: ${research.industry || ""}\nServices: ${research.coreServices || ""}`
        : "No verified prospect research is available. Do not describe the prospect's business at all.";
    const completion = await client.chat.completions.create({
        model: process.env.ASE_RESEARCH_MODEL || "gpt-4o-mini",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
            {
                role: "system",
                content: `You write one short B2B sales email. Use only the facts supplied. Never invent metrics, customers, results, news or familiarity. Never claim or imply that a conversation, meeting or call took place. Do not reuse sentences from previous emails. Sign as ${senderName}. Output JSON {subject, text}.`,
            },
            {
                role: "user",
                content: `Purpose: ${PURPOSE_BRIEF[purpose] || PURPOSE_BRIEF[STEP_PURPOSE.VALUE_EMAIL]}
Recipient first name: ${firstName}
Prospect company: ${company}
Seller brand: ${brandName || senderName}
Seller facts: ${JSON.stringify(seller || {})}
${facts}
Previous emails already sent (do not repeat):
${(previousBodies || []).map((b, i) => `#${i + 1}: ${String(b).slice(0, 400)}`).join("\n") || "none"}

Subject under 9 words. Body under 120 words. One clear call to action.`,
            },
        ],
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
    if (!parsed.subject || !parsed.text) return null;
    const text = stripSignoff(String(parsed.text));
    return { subject: String(parsed.subject), text, html: bodyToHtml(text) };
}

export function stripSignoff(text) {
    return String(text || "")
        .replace(/\r\n/g, "\n")
        .replace(/\n+[ \t]*(thank you|thanks|regards|best|best regards|kind regards|warm regards|many thanks|sincerely|cheers)[ \t]*[,!.]?[ \t]*(\n[^\n]{0,60}){0,3}\s*$/i, "")
        .trim();
}

async function resolveResearch(lead) {
    const meta = readMetadata(lead);
    if (isUsableResearchProfile(meta.company_research)) return meta.company_research;
    if (!lead.company) return null;
    try {
        const domain = lead.email ? lead.email.split("@")[1] : null;
        return await researchCompany(lead.company, { domain, leadInfo: { ...lead, metadata: meta } });
    } catch {
        return null;
    }
}

export async function draftCadenceEmail(lead, { purpose, previousBodies = [], senderName: senderOverride = null } = {}) {
    const playbook = await getActivePlaybook(Number(lead.organization_id || 0)).catch(() => null);
    const seller = playbook ? playbookFactsForAi(playbook) : {};
    const senderName = senderOverride || seller.senderName || env.novaSenderName || "NOVA AI";
    const brandName = seller.brandName || senderName;
    const firstName = lead.first_name || (lead.name ? String(lead.name).split(" ")[0] : "there");
    const company = lead.company || "your team";
    const research = await resolveResearch(lead);
    const grounded = isGroundedResearch(research);
    const base = { purpose, firstName, company, senderName, brandName, research, grounded, seller };
    const check = (email) => validateEmailDraft({ ...email, research, noPriorConversation: true, previousBodies });

    const client = grounded ? getOpenAiClient() : null;
    if (client) {
        try {
            const ai = await writeWithAi({ ...base, client, previousBodies });
            if (ai) {
                const cleaned = sanitizeOutreachEmail(ai, senderName);
                const quality = check(cleaned);
                if (quality.eligibleToSend) {
                    return finalize(cleaned, { quality, research, grounded, generator: "openai" });
                }
            }
        } catch (err) {
            console.warn("[Cadence] AI draft failed, using template:", err.message);
        }
    }

    const template = sanitizeOutreachEmail(buildCadenceTemplate(base), senderName);
    return finalize(template, { quality: check(template), research, grounded, generator: "template" });
}

function finalize(email, { quality, research, grounded, generator }) {
    const reviewReasons = [];
    if (!grounded) reviewReasons.push("WEAK_RESEARCH");
    if (!quality.eligibleToSend) reviewReasons.push(...quality.issues);
    return {
        subject: email.subject,
        text: email.text,
        html: email.html,
        generator,
        grounding: grounded ? "grounded" : "conservative",
        qualityChecks: quality,
        needsReview: reviewReasons.length > 0,
        reviewReasons,
        blocked: !quality.eligibleToSend,
        research: research
            ? {
                summary: research.summary || null,
                industry: research.industry || null,
                qualityStatus: research.qualityStatus || null,
                sources: (research.sources || []).slice(0, 5),
                researchedAt: research.researchedAt || null,
            }
            : null,
        draftedAt: new Date().toISOString(),
    };
}

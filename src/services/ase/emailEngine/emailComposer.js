import { PERSONAS } from "./contactRole.js";
import { CONVERSATION_STAGES } from "./communicationHistory.js";
import { CTA_STYLES, OPENING_STYLES } from "./personalizationStrategy.js";

const ROLE_OPENINGS = {
    [PERSONAS.EXECUTIVE]: [
        "Growing a B2B pipeline usually means a lot of repetitive work before a real sales conversation happens.",
        "As outreach grows, the manual work around it tends to grow faster than the team does.",
    ],
    [PERSONAS.SALES_LEADER]: [
        "A good part of a sales team's week can go into researching prospects and keeping follow-ups on track.",
        "Keeping every lead followed up on time gets harder as the pipeline grows.",
    ],
    [PERSONAS.BUSINESS_DEVELOPMENT]: [
        "Finding the right prospects is one job; writing a relevant note to each of them and following up is another.",
        "Personalizing outreach for every prospect takes time that business development teams rarely have.",
    ],
    [PERSONAS.MARKETING]: [
        "Personalizing campaigns for each audience, and then seeing who actually engaged, often means juggling several tools.",
        "Campaign outreach works best when each message fits the audience, which is hard to do at volume.",
    ],
    [PERSONAS.OPERATIONS]: [
        "When email and calling run in separate tools, follow-ups and handoffs are easy to miss.",
        "Keeping outreach consistent across email and calls usually depends on a lot of manual coordination.",
    ],
    [PERSONAS.HR_RECRUITMENT]: [
        "Recruitment outreach usually means many individual messages and follow-ups that are easy to lose track of.",
        "Keeping communication consistent across many conversations takes a lot of manual follow-up.",
    ],
    [PERSONAS.TECHNICAL]: [
        "Commercial teams often stitch outreach together from several disconnected tools.",
        "A lot of outreach work is still manual even when the rest of the stack is automated.",
    ],
    [PERSONAS.GENERAL]: [
        "For many B2B teams, researching prospects and keeping follow-ups consistent takes more time than it should.",
        "Managing B2B outreach at scale can mean a lot of time spent on research, personalization and follow-ups.",
    ],
};

const ROLE_BRIDGES = {
    [PERSONAS.EXECUTIVE]: "For a leadership team, that is time not spent on growth.",
    [PERSONAS.SALES_LEADER]: "That work matters, but it competes with time your team could spend selling.",
    [PERSONAS.BUSINESS_DEVELOPMENT]: "That can limit how many good conversations each person can start.",
    [PERSONAS.MARKETING]: "It also makes it harder to see which outreach is actually working.",
    [PERSONAS.OPERATIONS]: "Small gaps there add up across a full pipeline.",
    [PERSONAS.HR_RECRUITMENT]: "Coordinating those follow-ups is often where time goes.",
    [PERSONAS.TECHNICAL]: "That leaves room to simplify the workflow.",
    [PERSONAS.GENERAL]: "",
};

function trimSentence(text, max = 140) {
    const clean = String(text || "").replace(/\s+/g, " ").trim().replace(/[.!?…]+$/, "");
    if (clean.length <= max) return clean;
    return `${clean.slice(0, max).replace(/\s+\S*$/, "")}`;
}

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "its website";
    }
}

function joinNames(names) {
    if (names.length <= 1) return names[0] || "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function lowerFirst(text) {
    return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function upperFirst(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function hookSentence(hook, company) {
    if (!hook) return "";
    const value = String(hook.value || "");
    if (hook.type === "products") {
        const list = trimSentence(value.replace(/^products on their site:\s*/i, ""), 120);
        return list ? `I noticed ${company}'s website features ${list}.` : "";
    }
    if (hook.type === "hiring") return `I noticed ${company} has open roles listed on its job board.`;
    if (hook.type && hook.type !== "summary" && !hook.field) return "";
    const quote = trimSentence(value, 140);
    if (!quote) return "";
    const host = hostOf(hook.sourceUrl);
    const firstWord = quote.split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, "");
    const nameTokens = [company, host.split(".")[0]].map((item) => String(item).toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (nameTokens.some((token) => token && (token.startsWith(firstWord) || firstWord.startsWith(token.slice(0, 4))))) {
        return `I read on ${host} that ${quote}.`;
    }
    if (/^(we|our)\b/i.test(quote)) return `I was reading ${host}, which says: "${quote}".`;
    return `I was looking at ${host}, where ${company} describes its work as "${lowerFirst(quote)}".`;
}

function capabilitySentences(knowledge, capabilities, { withExample = true } = {}) {
    const names = capabilities.map((capability) => capability.name);
    const fromPlaybook = capabilities.some((capability) => capability.key.startsWith("playbook_"));
    if (fromPlaybook) return [`${knowledge.brandName} can help here with ${joinNames(names.map(lowerFirst))}.`];
    const first = capabilities[0];
    const lines = [`${knowledge.brandName} helps teams with this through ${joinNames(names)}.`];
    if (withExample && first?.benefit) lines.push(`For example, it ${first.benefit}.`);
    return lines;
}

const INDUSTRY_FRAMES = [
    (label, opportunity) => `If your team handles ${opportunity}, this could help streamline it.`,
    (label, opportunity) => `For ${label} companies looking to improve ${opportunity}, this could save a fair amount of manual work.`,
    (label, opportunity) => `Depending on your current outreach process, this could be useful for ${opportunity}.`,
];

function industrySentence(industry, seed) {
    if (!industry || (!industry.known && !industry.subIndustry)) return "";
    const label = (industry.known ? industry.label : industry.subIndustry)
        .split(/ and |,/)[0]
        .trim()
        .split(/\s+/)
        .map((word) => (/[A-Z]/.test(word.slice(1)) ? word : word.toLowerCase()))
        .join(" ");
    const frame = INDUSTRY_FRAMES[seed % INDUSTRY_FRAMES.length];
    return frame(label, industry.opportunity);
}

function ctaText(strategy, { company, knowledge }) {
    if (strategy.stage === CONVERSATION_STAGES.FIRST_OUTREACH && knowledge.preferredCta) {
        const cta = knowledge.preferredCta.trim();
        return /\?$/.test(cta) ? cta : `${cta.replace(/[.!]+$/, "")}?`;
    }
    const link = knowledge.meetingLink;
    switch (strategy.ctaStyle) {
        case CTA_STYLES.BRIEF_DEMO:
            return "Would you be open to a brief 15-minute demo to see how it works?";
        case CTA_STYLES.SHORT_CALL:
            return "Would a short call in the next week or two be useful?";
        case CTA_STYLES.WORTH_EXPLORING:
            return `Is this worth exploring for ${company} right now?`;
        case CTA_STYLES.SEND_OVERVIEW:
            return "Would it help if I sent a short overview you can look at when convenient?";
        case CTA_STYLES.SCHEDULE_NEXT_STEP:
            return link
                ? `Would a short demo this week or next suit you (you can pick a time here: ${link})?`
                : "Would a short demo this week or next suit you, and which times work best?";
        case CTA_STYLES.CONFIRM_CALL_TIME:
            return "What is the best number and time to reach you?";
        case CTA_STYLES.LOW_PRESSURE:
            return "Would it be all right if I checked back in a few months, or would you prefer I close the loop for now?";
        case CTA_STYLES.ANSWER_FOLLOW_UP:
            return "Does that answer your question, or would a short demo be easier?";
        default:
            return "Would a brief conversation be useful?";
    }
}

function tokens(text) {
    return new Set(String(text || "").toLowerCase().match(/[a-z]{4,}/g) || []);
}

function bestMatch(items, text, key) {
    const wanted = tokens(text);
    let best = null;
    let bestScore = 0;
    for (const item of items || []) {
        const overlap = [...tokens(item[key])].filter((token) => wanted.has(token)).length;
        if (overlap > bestScore) {
            best = item;
            bestScore = overlap;
        }
    }
    return bestScore >= 2 ? best : null;
}

export function composeFallbackEmail({ firstName, company, role, industry = null, history, knowledge, strategy }) {
    const greeting = `Hi ${firstName},`;
    const paragraphs = [];
    const factRefs = [];
    const needsHumanInput = [];
    const persona = role.persona;
    const roleOpenings = ROLE_OPENINGS[persona] || ROLE_OPENINGS[PERSONAS.GENERAL];
    const capabilities = strategy.capabilities;
    const question = history.latestInbound?.text || "";

    switch (strategy.stage) {
        case CONVERSATION_STAGES.FOLLOW_UP_NO_REPLY: {
            const capability = capabilities[0];
            paragraphs.push(`A quick follow-up on my earlier note, this time on ${strategy.angle}.`);
            paragraphs.push(capability?.key?.startsWith("playbook_")
                ? `${knowledge.brandName} offers ${lowerFirst(capability.name)}.`
                : `One thing ${knowledge.brandName} does that may help here: it ${capability.benefit}.`);
            break;
        }
        case CONVERSATION_STAGES.ANSWER_QUESTION: {
            const asksPrice = /\b(price|pricing|cost|how much|plan|plans)\b/i.test(question);
            const faq = bestMatch(knowledge.faqs, question, "q");
            paragraphs.push("Thanks for your question.");
            if (asksPrice && knowledge.pricing) paragraphs.push(`Here is our current pricing: ${knowledge.pricing}`);
            else if (faq) paragraphs.push(faq.a);
            else {
                paragraphs.push("I want to give you an accurate answer, so I am confirming the details with our team and will come back to you shortly.");
                needsHumanInput.push("answer_to_prospect_question");
            }
            break;
        }
        case CONVERSATION_STAGES.CONTINUE_INTEREST:
            paragraphs.push(`Thanks for getting back to me, glad this looks relevant for ${company}.`);
            paragraphs.push(`The quickest way to see whether it fits is a short demo focused on ${joinNames(capabilities.map((capability) => lowerFirst(capability.name.replace(/^the /i, ""))))}.`);
            break;
        case CONVERSATION_STAGES.HANDLE_OBJECTION: {
            const match = bestMatch(knowledge.objections, question, "objection");
            paragraphs.push("Thanks for letting me know, and that makes sense.");
            if (match) paragraphs.push(match.response);
            else paragraphs.push("I will not keep filling your inbox.");
            break;
        }
        case CONVERSATION_STAGES.CALLBACK_ACKNOWLEDGE:
            paragraphs.push("Thanks for letting me know. Someone from our team will call you.");
            break;
        case CONVERSATION_STAGES.ACTIVE_CONVERSATION:
            paragraphs.push("Thanks for your reply.");
            paragraphs.push(`Happy to share more about ${joinNames(capabilities.map((capability) => lowerFirst(capability.name.replace(/^the /i, ""))))} whenever it is useful.`);
            break;
        default: {
            let opening = "";
            if (strategy.openingStyle === OPENING_STYLES.COMPANY_FACT || strategy.openingStyle === OPENING_STYLES.COMPANY_CONTEXT) {
                opening = hookSentence(strategy.researchHook, company);
                if (opening && strategy.researchHook?.id) factRefs.push(strategy.researchHook.id);
            }
            const challenge = roleOpenings[strategy.seed % roleOpenings.length];
            if (opening) {
                paragraphs.push(opening);
                paragraphs.push(`${challenge} ${ROLE_BRIDGES[persona] || ""}`.trim());
            } else {
                paragraphs.push(`${challenge} ${ROLE_BRIDGES[persona] || ""}`.trim());
            }
            const industryLine = industrySentence(industry, strategy.seed >>> 2);
            paragraphs.push(capabilitySentences(knowledge, capabilities, { withExample: !industryLine || !opening }).join(" "));
            paragraphs.push(industryLine || "The aim is to spend less time on repetitive outreach tasks and more time in conversations with potential customers.");
        }
    }

    const cta = ctaText(strategy, { company, knowledge });
    const subject = composeSubject({ company, strategy, history, role });
    return {
        subject,
        greeting,
        paragraphs: paragraphs.map(upperFirst),
        cta,
        factRefs,
        capabilitiesUsed: capabilities.map((capability) => capability.key),
        personalizationReason: strategy.personalizationReason,
        needsHumanInput,
    };
}

function composeSubject({ company, strategy, history }) {
    const lastSubject = history.previousSubjects[history.previousSubjects.length - 1] || "";
    if (strategy.stage !== CONVERSATION_STAGES.FIRST_OUTREACH && strategy.stage !== CONVERSATION_STAGES.FOLLOW_UP_NO_REPLY) {
        const base = String(history.latestInbound?.subject || lastSubject || `Your note to us`).replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").trim();
        return `Re: ${base}`.slice(0, 120);
    }
    const options = strategy.stage === CONVERSATION_STAGES.FOLLOW_UP_NO_REPLY
        ? [`One more idea for ${company}`, `${upperFirst(strategy.angle)} at ${company}`, `A different angle for ${company}`]
        : [`Simplifying sales outreach at ${company}`, `${upperFirst(strategy.angle)} at ${company}`, `A question about outreach at ${company}`, `Less manual outreach work at ${company}`];
    const avoid = new Set(strategy.avoid.subjects.map((item) => String(item).toLowerCase()));
    const fresh = options.filter((item) => !avoid.has(item.toLowerCase()));
    const pool = fresh.length ? fresh : options;
    return pool[strategy.seed % pool.length];
}

import { getOpenAiClient } from "../../controllers/OpenAI/client.js";
import { tryPlaybookEmail, followupTypeForStep } from "../ase/salesPlaybook.service.js";

function shouldBypassAi(options = {}) {
    if (options.forceDeterministic) return true;
    if (process.env.NODE_ENV === "test" || process.env.TEST === "true") return true;
    if (typeof process.env.NODE_TEST_CONTEXT !== "undefined") return true;
    if (process.argv.some((a) => typeof a === "string" && (a.includes("test") || a.includes(".test.")))) return true;
    return false;
}

export const followUpContentService = {
    async generateStepContent(stepNumber, lead = {}, initialContext = {}, options = {}) {
        const playbookEmail = await tryPlaybookEmail(lead, followupTypeForStep(stepNumber));
        if (playbookEmail) return playbookEmail;

        const safeLead = lead || {};
        const meta = typeof safeLead.metadata === "object" && safeLead.metadata ? safeLead.metadata : {};
        const research = meta.company_research || initialContext.research || {};
        const rawCompany = research.company || safeLead.company || (safeLead.email ? safeLead.email.split("@")[1].split(".")[0] : "your company");
        const company = rawCompany ? rawCompany.charAt(0).toUpperCase() + rawCompany.slice(1) : "Company";
        const firstName = safeLead.first_name || (safeLead.name ? safeLead.name.split(" ")[0] : "there");
        const initialSubject = initialContext.subject || meta.outreach_email?.subject || `${company}: a note on growth`;
        const senderName = initialContext.senderName || "NOVA AI";
        const industry = research.industry || "";
        const offering = research.coreServices || research.summary || company;
        const targetAudience = research.targetAudience || company;

        if (!shouldBypassAi(options)) {
            const client = getOpenAiClient();
            if (client) {
                try {
                    const aiResult = await this.generateWithAi(client, stepNumber, {
                        firstName,
                        company,
                        industry,
                        offering,
                        targetAudience,
                        initialSubject,
                        senderName,
                        research,
                    });
                    if (aiResult) return aiResult;
                } catch (_) {}
            }
        }

        return this.generateDeterministicContent(stepNumber, {
            firstName,
            company,
            industry,
            offering,
            targetAudience,
            initialSubject,
            senderName,
            research,
        });
    },

    async generateWithAi(client, stepNumber, ctx) {
        const prompts = {
            1: `Write Follow-up 1 for cold email.
Recipient: ${ctx.firstName} at ${ctx.company}.
Previous email subject: ${ctx.initialSubject}.
Goal: Brief, helpful touch in existing thread. Ask one thoughtful question about their challenge regarding ${ctx.offering}. Do NOT repeat the initial pitch. Do NOT include a calendar link. Under 60 words.
JSON output: { "subject": "Re: ${ctx.initialSubject}", "text": "...", "html": "<p>...</p>" }`,

            2: `Write Follow-up 2 for cold email (Day 7).
Recipient: ${ctx.firstName} at ${ctx.company} (${ctx.industry}).
Core offerings: ${ctx.offering}.
Goal: New thread with a relevant insight, concise case study, or practical benchmark for ${ctx.company}. Under 90 words.
JSON output: { "subject": "...", "text": "...", "html": "<p>...</p>" }`,

            3: `Write Follow-up 3 for cold email (Day 14).
Recipient: ${ctx.firstName} at ${ctx.company}.
Goal: Address common hesitation around bandwidth or complexity. Offer a helpful breakdown or resource. Invite any questions. Under 80 words.
JSON output: { "subject": "...", "text": "...", "html": "<p>...</p>" }`,

            4: `Write Follow-up 4 for cold email (Day 28).
Recipient: ${ctx.firstName} at ${ctx.company}.
Goal: Personalized video concept and custom script for human review. Include a suggested opening, 1 observation about ${ctx.company}, 1 actionable recommendation, low pressure call to action. Under 110 words.
JSON output: { "subject": "...", "text": "...", "html": "<p>...</p>", "videoConcept": { "hook": "...", "observation": "...", "recommendation": "...", "cta": "..." } }`,

            5: `Write Follow-up 5 for cold email (Day 42).
Recipient: ${ctx.firstName} at ${ctx.company}.
Goal: Polite, final check-in. Ask whether they would prefer to revisit later. Respectful close. Under 50 words.
JSON output: { "subject": "Re: ${ctx.initialSubject}", "text": "...", "html": "<p>...</p>" }`,
        };

        const promptText = prompts[stepNumber];
        if (!promptText) return null;

        const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages: [
                { role: "system", content: "You are an elite B2B sales automation assistant. Return valid JSON only." },
                { role: "user", content: promptText },
            ],
        });

        const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
        if (parsed.text && parsed.subject) {
            return {
                subject: parsed.subject,
                text: parsed.text,
                html: parsed.html || `<p>${parsed.text.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`,
                videoConcept: parsed.videoConcept || null,
            };
        }
        return null;
    },

    generateDeterministicContent(stepNumber, ctx) {
        if (stepNumber === 1) {
            const subject = ctx.initialSubject.startsWith("Re:") ? ctx.initialSubject : `Re: ${ctx.initialSubject}`;
            const text = `Hi ${ctx.firstName},\n\nWanted to make sure my previous note about ${ctx.company} reached you.\n\nQuick question: is streamlining how you reach ${ctx.targetAudience} a current priority for your team this quarter, or is bandwidth focused elsewhere?\n\nBest regards,\n${ctx.senderName}`;
            const html = `<p>Hi ${ctx.firstName},</p><p>Wanted to make sure my previous note about <strong>${ctx.company}</strong> reached you.</p><p>Quick question: is streamlining how you reach ${ctx.targetAudience} a current priority for your team this quarter, or is bandwidth focused elsewhere?</p><p>Best regards,<br>${ctx.senderName}</p>`;
            return { subject, text, html, videoConcept: null };
        }

        if (stepNumber === 2) {
            const subject = `${ctx.company}: practical benchmark for ${ctx.industry}`;
            const text = `Hi ${ctx.firstName},\n\nI was reviewing how firms specializing in ${ctx.offering} scale outbound pipelines. Teams with similar offerings often see a 3x higher response rate when outreach is aligned directly with prospect website signals.\n\nI put together a 1-page summary of how ${ctx.company} could apply this approach without adding headcount. Would you like me to send it over?\n\nBest regards,\n${ctx.senderName}`;
            const html = `<p>Hi ${ctx.firstName},</p><p>I was reviewing how firms specializing in ${ctx.offering} scale outbound pipelines. Teams with similar offerings often see a 3x higher response rate when outreach is aligned directly with prospect website signals.</p><p>I put together a 1-page summary of how <strong>${ctx.company}</strong> could apply this approach without adding headcount. Would you like me to send it over?</p><p>Best regards,<br>${ctx.senderName}</p>`;
            return { subject, text, html, videoConcept: null };
        }

        if (stepNumber === 3) {
            const subject = `Addressing bandwidth concerns at ${ctx.company}`;
            const text = `Hi ${ctx.firstName},\n\nWhen we talk with leaders in ${ctx.industry}, the biggest hesitation is usually time: 'We do not have weeks to set up another sales tool.'\n\nThat is why NOVA runs autonomously in the background, integrating directly into existing workflows without rep maintenance. Happy to share a quick 2-minute overview or answer any specific questions you have.\n\nBest regards,\n${ctx.senderName}`;
            const html = `<p>Hi ${ctx.firstName},</p><p>When we talk with leaders in ${ctx.industry}, the biggest hesitation is usually time: <em>'We do not have weeks to set up another sales tool.'</em></p><p>That is why NOVA runs autonomously in the background, integrating directly into existing workflows without rep maintenance. Happy to share a quick 2-minute overview or answer any specific questions you have.</p><p>Best regards,<br>${ctx.senderName}</p>`;
            return { subject, text, html, videoConcept: null };
        }

        if (stepNumber === 4) {
            const subject = `${ctx.company}: Personalized video walkthrough concept`;
            const videoConcept = {
                targetCompany: ctx.company,
                openingHook: `Hi ${ctx.firstName}, here is a 90-second teardown of how ${ctx.company} appears to outbound prospects.`,
                observation: `Your focus on ${ctx.offering} is strong, but outreach signals could be amplified with automated triggers.`,
                recommendation: `Integrate autonomous cadence scoring to engage leads before competitors do.`,
                cta: `No commitment needed; let me know if this observation aligns with your goals.`,
            };

            const text = `Hi ${ctx.firstName},\n\nI recorded a brief concept breakdown for ${ctx.company}. Here is the outline:\n\n• Observation: ${videoConcept.observation}\n• Recommendation: ${videoConcept.recommendation}\n• Low-pressure takeaway: ${videoConcept.cta}\n\nWould you be interested in seeing the full walkthrough video?\n\nBest regards,\n${ctx.senderName}`;
            const html = `<p>Hi ${ctx.firstName},</p><p>I recorded a brief concept breakdown for <strong>${ctx.company}</strong>. Here is the outline:</p><ul><li><strong>Observation:</strong> ${videoConcept.observation}</li><li><strong>Recommendation:</strong> ${videoConcept.recommendation}</li><li><strong>Next step:</strong> ${videoConcept.cta}</li></ul><p>Would you be interested in seeing the full walkthrough video?</p><p>Best regards,<br>${ctx.senderName}</p>`;
            return { subject, text, html, videoConcept };
        }

        const subject = ctx.initialSubject.startsWith("Re:") ? ctx.initialSubject : `Re: ${ctx.initialSubject}`;
        const text = `Hi ${ctx.firstName},\n\nI know schedules get hectic. I will step back for now so I do not crowd your inbox.\n\nIf exploring growth and outreach automation for ${ctx.company} becomes relevant down the road, feel free to reconnect anytime.\n\nWishing you and the team continued success.\n\nBest regards,\n${ctx.senderName}`;
        const html = `<p>Hi ${ctx.firstName},</p><p>I know schedules get hectic. I will step back for now so I do not crowd your inbox.</p><p>If exploring growth and outreach automation for <strong>${ctx.company}</strong> becomes relevant down the road, feel free to reconnect anytime.</p><p>Wishing you and the team continued success.</p><p>Best regards,<br>${ctx.senderName}</p>`;
        return { subject, text, html, videoConcept: null };
    },

    async generateResponseDraft(lead = {}, replyPayload = {}, initialContext = {}, options = {}) {
        const safeLead = lead || {};
        const meta = typeof safeLead.metadata === "object" && safeLead.metadata ? safeLead.metadata : {};
        const research = meta.company_research || initialContext.research || {};
        const firstName = safeLead.first_name || (safeLead.name ? safeLead.name.split(" ")[0] : "there");
        const company = research.company || safeLead.company || "your team";
        const replySubject = replyPayload.subject || initialContext.subject || "Outreach inquiry";
        const subject = replySubject.startsWith("Re:") ? replySubject : `Re: ${replySubject}`;
        const senderName = initialContext.senderName || "NOVA AI";
        const replyText = String(replyPayload.replyText || replyPayload.body || "").trim();

        const clean = (value) => String(value || "")
            .replace(/\[Your Name\]/gi, "")
            .replace(/\[Name\]/gi, "")
            .replace(/Your Name/g, "")
            .replace(/NOVVA AI/gi, senderName)
            .replace(/\s*Best regards[\s\S]*$/i, `\n\nBest regards,\n${senderName}`)
            .replace(/\n{3,}/g, "\n\n")
            .trim();

        if (!shouldBypassAi(options)) {
            const client = getOpenAiClient();
            if (client) {
                try {
                    const prompt = `Prospect ${firstName} at ${company} replied to our outreach.
Their exact reply: "${replyText || "(no body)"}".
Company context: ${research.summary || company}.
Write one email that answers their reply directly. Under 90 words. No invented metrics. No placeholders. Close with Best regards, ${senderName}.
JSON output: { "subject": "${subject}", "text": "...", "html": "<p>...</p>" }`;

                    const response = await client.chat.completions.create({
                        model: "gpt-4o-mini",
                        temperature: 0.3,
                        response_format: { type: "json_object" },
                        messages: [
                            { role: "system", content: "You write reply emails from the prospect's message. Return JSON only. Never use placeholders like [Your Name]." },
                            { role: "user", content: prompt },
                        ],
                    });
                    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
                    if (parsed.text) {
                        const text = clean(parsed.text);
                        return {
                            subject: clean(parsed.subject || subject),
                            text,
                            html: clean(parsed.html || `<p>${text.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`),
                        };
                    }
                } catch (_) {}
            }
        }

        const text = `Hi ${firstName},\n\nThank you for your reply${replyText ? ` — I read your note about ${company}` : ` regarding ${company}`}. I would be glad to continue this conversation and answer your questions.\n\nWould you have 10-15 minutes later this week?\n\nBest regards,\n${senderName}`;
        const html = `<p>Hi ${firstName},</p><p>Thank you for your reply${replyText ? ` — I read your note about <strong>${company}</strong>` : ` regarding <strong>${company}</strong>`}. I would be glad to continue this conversation and answer your questions.</p><p>Would you have 10-15 minutes later this week?</p><p>Best regards,<br>${senderName}</p>`;

        return { subject, text, html };
    },
};

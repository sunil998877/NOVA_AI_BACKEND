import { test } from "node:test";
import assert from "node:assert/strict";
import {
    validatePlaybook,
    renderPlaybookEmail,
    buildVoiceContext,
    EMAIL_TYPES,
} from "../services/ase/salesPlaybook.service.js";

const completePlaybook = {
    brandName: "Harbor Ops",
    companyName: "Harbor Ops",
    companyDescription: "Harbor Ops provides operations software for mid-market teams.",
    productName: "Harbor Flow",
    productDescription: "A workflow tool for operations teams.",
    painPoints: ["manual handoffs between sales and delivery"],
    valuePropositions: ["keeps approved work moving without extra admin"],
    senderName: "Priya Shah",
    preferredCta: "Would you like a brief conversation this week?",
    pricing: "Plans start after a scoped review.",
    neverClaim: ["guaranteed revenue increase"],
    voiceIntroduction: "Hello {{first_name}}, this is {{sender_name}} from {{brand_name}}. Is now a good time?",
    faqs: [{ q: "What do you sell?", a: "Harbor Flow for operations teams." }],
    objections: [{ objection: "We already have a tool", response: "We only share how Harbor Flow handles handoffs." }],
};

const lead = { first_name: "Alex", name: "Alex Rivera", company: "Northwind" };

test("incomplete playbook cannot send or invent product details", () => {
    const validation = validatePlaybook({ brandName: "Harbor Ops" });
    assert.equal(validation.canSendEmail, false);
    assert.ok(validation.missing.includes("productName"));
    assert.ok(validation.missing.includes("valuePropositions"));
    assert.ok(validation.missing.includes("senderName"));

    const email = renderPlaybookEmail({ brandName: "Harbor Ops" }, EMAIL_TYPES.INITIAL, lead);
    assert.equal(email.activated, false);
});

test("complete playbook renders approved email content only", () => {
    const email = renderPlaybookEmail(completePlaybook, EMAIL_TYPES.INITIAL, lead);
    assert.equal(email.activated, true);
    assert.match(email.subject, /Northwind/);
    assert.match(email.text, /Harbor Ops/);
    assert.match(email.text, /Harbor Flow/);
    assert.match(email.text, /keeps approved work moving/);
    assert.match(email.text, /Priya Shah/);
    assert.doesNotMatch(email.text, /guaranteed revenue/i);
    assert.doesNotMatch(email.text, /\{\{/);
});

test("pricing email stays inactive when pricing is missing", () => {
    const email = renderPlaybookEmail({ ...completePlaybook, pricing: "" }, EMAIL_TYPES.PRICING, lead);
    assert.equal(email.activated, false);
    assert.ok(email.missing.includes("approved_pricing"));
});

test("voice agent uses approved introduction and never-claim list", () => {
    const voice = buildVoiceContext(completePlaybook, lead);
    assert.equal(voice.activated, true);
    assert.match(voice.openingLine, /Priya Shah/);
    assert.match(voice.openingLine, /Harbor Ops/);
    assert.doesNotMatch(voice.openingLine, /Evoke AI/);
    assert.deepEqual(voice.neverClaim, ["guaranteed revenue increase"]);
    assert.equal(voice.faqs[0].a, "Harbor Flow for operations teams.");
});

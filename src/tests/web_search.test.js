import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
    cleanCitationUrl,
    companyNameVariants,
    parseSearchJson,
    searchCompanyEvents,
    verifyEvent,
} from "../modules/intelligence/providers/webSearch.provider.js";
import { enrichWithWebSearch } from "../modules/intelligence/services/research.service.js";
import { buildOutreachSignals } from "../modules/intelligence/services/signals.service.js";
import { htmlToText } from "../modules/intelligence/providers/website.provider.js";

const NOW = Date.UTC(2026, 9, 31);
const ARTICLE = {
    url: "https://news.example-press.com/acme-series-b",
    title: "Acme raises $20 million Series B - Example Press",
    text: "March 12, 2026. Acme Payments has raised $20 million in a Series B round led by Fund Partners to expand into Southeast Asia.",
    retrievedAt: "2026-10-31T00:00:00.000Z",
};
const names = companyNameVariants("Acme Payments Pvt Ltd", "acme.in");

function fakeClient(events, calls = []) {
    return {
        responses: {
            async create(body) {
                calls.push(body);
                return { output_text: `Here you go:\n${JSON.stringify({ events })}`, output: [] };
            },
        },
    };
}

describe("web search verification", () => {
    test("name variants strip legal suffixes and include the domain root", () => {
        assert.deepEqual(names, ["acme payments", "acme"]);
    });

    test("tracking params are removed from cited URLs; non-http is rejected", () => {
        assert.equal(cleanCitationUrl("https://x.com/a?utm_source=openai&id=2#top"), "https://x.com/a?id=2");
        assert.equal(cleanCitationUrl("javascript:alert(1)"), null);
    });

    test("tolerates prose around the JSON and bad JSON", () => {
        assert.equal(parseSearchJson('ok {"events":[{"text":"a"}]} done').events.length, 1);
        assert.deepEqual(parseSearchJson("no json").events, []);
    });

    test("recovers complete events from a response cut off mid-JSON", () => {
        const cut = '```json\n{"events": [{"text": "a {b}", "quote": "say \\"hi\\""}, {"text": "c"}, {"text": "trunc';
        assert.deepEqual(parseSearchJson(cut).events.map((e) => e.text), ["a {b}", "c"]);
    });

    test("keeps an event whose quote is on the fetched page and names the company", () => {
        const { fact } = verifyEvent({
            category: "funding",
            text: "Acme Payments raised $20M Series B",
            date: "2026-03-12",
            url: ARTICLE.url,
            quote: "Acme Payments has raised $20 million in a Series B round",
        }, ARTICLE, { names, now: NOW });
        assert.equal(fact.verificationStatus, "verified");
        assert.equal(fact.date, "2026-03-12");
        assert.equal(fact.sourceUrl, ARTICLE.url);
    });

    test("rejects quotes not on the page, unnamed companies, stale and unfetchable events", () => {
        const base = { text: "x happened", url: ARTICLE.url };
        assert.equal(verifyEvent({ ...base, quote: "Acme Payments was acquired by a giant corp" }, ARTICLE, { names, now: NOW }).rejected.reason, "QUOTE_NOT_ON_PAGE");
        const other = { ...ARTICLE, title: "Funding roundup", text: "Zeta Corp has raised $20 million in a Series B round." };
        assert.equal(verifyEvent({ ...base, quote: "has raised $20 million in a Series B round" }, other, { names, now: NOW }).rejected.reason, "COMPANY_NOT_NAMED");
        const old = { ...ARTICLE, text: "2021: Acme Payments has raised $20 million in a Series B round." };
        assert.equal(verifyEvent({ ...base, date: "2021-01", quote: "Acme Payments has raised $20 million" }, old, { names, now: NOW }).rejected.reason, "STALE_EVENT");
        assert.equal(verifyEvent({ ...base, quote: "Acme Payments has raised" }, { url: ARTICLE.url, blocked: "ROBOTS_DISALLOWED" }, { names, now: NOW }).rejected.reason, "ROBOTS_DISALLOWED");
    });

    test("rejects summaries that add numbers or names the page does not contain", () => {
        const quote = "Acme Payments has raised $20 million in a Series B round";
        const inflated = verifyEvent({ text: "Acme Payments raised $50M led by Sequoia", url: ARTICLE.url, quote }, ARTICLE, { names, now: NOW });
        assert.equal(inflated.rejected.reason, "TEXT_NOT_SUPPORTED");
        assert.deepEqual(inflated.rejected.missing, ["50", "sequoia"]);
    });

    test("rejects quotes that mostly vanish under normalization (non-Latin script)", () => {
        const page = { ...ARTICLE, text: "Acme Payments 3.0 アクメは今や単なるツールではありません。業務を共に行うAIチームメイト" };
        const weak = verifyEvent({ text: "Acme Payments launched 3.0", url: ARTICLE.url, quote: "Acme Payments 3.0 アクメは今や単なるツールではありません。業務を共に行うAIチームメイト" }, page, { names, now: NOW });
        assert.equal(weak.rejected.reason, "QUOTE_TOO_WEAK");
    });

    test("a date not printed on the page is dropped instead of trusted", () => {
        const { fact } = verifyEvent({ text: "Acme expands", date: "2025-06", url: ARTICLE.url, quote: "Acme Payments has raised $20 million" }, ARTICLE, { names, now: NOW });
        assert.equal(fact.date, null);
    });

    test("disabled by default and respects the daily limit", async () => {
        const off = await searchCompanyEvents(fakeClient([]), { company: "Acme", domain: "acme.in" }, { enabled: false });
        assert.equal(off.status, "disabled");
        const capped = await searchCompanyEvents(fakeClient([]), { company: "Acme", domain: "acme.in" }, { enabled: true, dailyLimit: 0 });
        assert.equal(capped.status, "daily_limit");
    });

    test("end to end: only verified events survive, pages fetched once per URL", async () => {
        const fetched = [];
        const calls = [];
        const client = fakeClient([
            { category: "funding", text: "Acme Payments raised $20M Series B", date: "2026-03", url: `${ARTICLE.url}?utm_source=openai`, quote: "Acme Payments has raised $20 million in a Series B round" },
            { category: "launch", text: "Acme launched a card", url: ARTICLE.url, quote: "Acme Payments launched a corporate card today" },
        ], calls);
        const result = await searchCompanyEvents(client, { company: "Acme Payments", domain: "acme.in" }, {
            enabled: true,
            dailyLimit: 1000,
            fetchPage: async (url) => {
                fetched.push(url);
                return ARTICLE;
            },
        });
        assert.equal(calls[0].tools[0].type, "web_search");
        assert.match(calls[0].input, /acme\.in/);
        assert.deepEqual(fetched, [ARTICLE.url]);
        assert.equal(result.facts.length, 1);
        assert.equal(result.rejected[0].reason, "QUOTE_NOT_ON_PAGE");
    });
});

describe("web search enrichment", () => {
    const grounded = {
        company: "Acme Payments",
        domain: "acme.in",
        summary: "Acme Payments builds payment APIs.",
        source: "website_scrape",
        sources: [{ url: "https://acme.in/", pageType: "home" }],
        facts: [],
        qualityStatus: "HIGH_CONFIDENCE",
        qualityReasons: ["DOMAIN_RESOLVED"],
    };
    const client = fakeClient([{ category: "funding", text: "Acme Payments raised $20M Series B", date: "2026-03", url: ARTICLE.url, quote: "Acme Payments has raised $20 million in a Series B round" }]);
    const opts = { client, enabled: true, dailyLimit: 1000, fetchPage: async () => ARTICLE };

    test("adds verified events, third-party sources and a news signal", async () => {
        const profile = await enrichWithWebSearch(grounded, { effectiveDomain: "acme.in", effectiveCompany: "Acme Payments" }, opts);
        assert.equal(profile.webSearch.verified, 1);
        assert.ok(profile.sources.some((s) => s.pageType === "third_party"));
        assert.ok(profile.qualityReasons.includes("WEB_SEARCH_VERIFIED"));
        const news = buildOutreachSignals(profile).find((s) => s.type === "news_funding");
        assert.match(news.text, /Published 2026-03 on news\.example-press\.com: "Acme Payments has raised \$20 million/);
    });

    test("undated web events stay in the profile but are not used as outreach signals", async () => {
        const undated = fakeClient([{ category: "news", text: "Acme Payments raised $20M Series B", url: ARTICLE.url, quote: "Acme Payments has raised $20 million in a Series B round" }]);
        const profile = await enrichWithWebSearch(grounded, { effectiveDomain: "acme.in" }, { ...opts, client: undated });
        assert.equal(profile.webSearch.verified, 1);
        assert.equal(buildOutreachSignals(profile).some((s) => s.type.startsWith("news_")), false);
    });

    test("never runs on ungrounded research", async () => {
        const guess = { ...grounded, source: "openai_company_lookup", qualityStatus: "NEEDS_REVIEW" };
        const profile = await enrichWithWebSearch(guess, { effectiveDomain: "acme.in" }, opts);
        assert.equal(profile, guess);
    });

    test("search errors keep the original research", async () => {
        const broken = { responses: { create: async () => { throw new Error("boom"); } } };
        const profile = await enrichWithWebSearch(grounded, { effectiveDomain: "acme.in" }, { ...opts, client: broken });
        assert.equal(profile.webSearch.status, "error");
        assert.equal(profile.facts.length, 0);
    });

    test("htmlToText strips scripts and keeps article text", () => {
        assert.equal(htmlToText("<p>Hello <b>world</b></p><script>evil()</script>"), "Hello world");
    });
});

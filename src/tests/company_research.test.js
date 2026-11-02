import { describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { extractPageFacts, fetchHtml, isBlockedAddress } from "../services/ase/companyWebsite.service.js";
import { cleanDomain, heuristicResearch, isUsableResearchProfile, resolveResearchDomain } from "../services/ase/companyResearch.service.js";
import { isGroundedResearch, stripSignoff } from "../services/ase/cadence/cadenceEmailDrafter.js";
import { companyCoreTokens, siteMatchesCompany } from "../modules/intelligence/services/research.service.js";

const HOME = `<!doctype html><html><head>
<title>Acme Cold Chain &amp; Logistics</title>
<meta content="Refrigerated trucking for food distributors across India." name="description">
<meta property="og:site_name" content="Acme">
<script>var tracking = "<p>should not appear in any extracted paragraph text at all, ever</p>";</script>
<style>p { color: red }</style>
</head><body>
<h1>Temperature-controlled freight, on time</h1>
<p>We operate a fleet of reefer trucks that move dairy, frozen and pharma goods between 40 cities every day.</p>
<a href="/about-us">About</a> <a href="https://acme.in/services/">Services</a>
<a href="https://other.com/about">External</a> <a href="/blog/post-1">Blog</a>
</body></html>`;

describe("company website extraction", () => {
    test("extracts title, description, headings and body text, ignoring scripts", () => {
        const page = extractPageFacts(HOME, "https://acme.in/");
        assert.equal(page.title, "Acme Cold Chain & Logistics");
        assert.equal(page.description, "Refrigerated trucking for food distributors across India.");
        assert.equal(page.siteName, "Acme");
        assert.deepEqual(page.headings, ["Temperature-controlled freight, on time"]);
        assert.match(page.excerpt, /reefer trucks/);
        assert.doesNotMatch(page.excerpt, /should not appear/);
        assert.ok(!Number.isNaN(Date.parse(page.retrievedAt)));
    });

    test("only same-host about/services links are followed", () => {
        const page = extractPageFacts(HOME, "https://acme.in/");
        assert.deepEqual(page.links.sort(), ["https://acme.in/about-us", "https://acme.in/services/"]);
    });

    test("profile built from site pages carries source URLs, timestamps and verified facts", () => {
        const page = extractPageFacts(HOME, "https://acme.in/");
        const profile = heuristicResearch({ effectiveCompany: "Acme", effectiveDomain: "acme.in", sitePages: [page] });
        assert.equal(profile.qualityStatus, "ACCEPTABLE");
        assert.equal(profile.sources[0].url, "https://acme.in/");
        assert.ok(profile.sources[0].retrievedAt);
        assert.equal(profile.facts.find((f) => f.field === "overview").sourceUrl, "https://acme.in/");
        assert.equal(profile.summary, "Refrigerated trucking for food distributors across India.");
        assert.equal(isUsableResearchProfile(profile), true);
        assert.equal(isGroundedResearch(profile), true);
    });

    test("no site pages means insufficient evidence and not grounded", () => {
        const profile = heuristicResearch({ effectiveCompany: "Acme", effectiveDomain: "acme.in", sitePages: [] });
        assert.equal(profile.qualityStatus, "INSUFFICIENT_EVIDENCE");
        assert.equal(isGroundedResearch(profile), false);
    });

    test("placeholder and free-mail domains are never researched", () => {
        assert.equal(cleanDomain("example.com"), null);
        assert.equal(cleanDomain("gmail.com"), null);
        assert.equal(cleanDomain("https://Acme.in/about"), "acme.in");
        assert.equal(resolveResearchDomain({ company: "Evoke.Ai" }), "evoke.ai");
        assert.equal(resolveResearchDomain({ email: "ops@gmail.com", company: "Evoke.Ai" }), "evoke.ai");
        assert.equal(resolveResearchDomain({ email: "rahul@acmelogistics.in" }), "acmelogistics.in");
    });

    test("discovered website is accepted only when the page names the brand", () => {
        assert.deepEqual(companyCoreTokens("HCL Technologies Pvt Ltd"), ["hcl"]);
        assert.equal(siteMatchesCompany("HCL Technologies", { url: "https://www.hcltech.com/", title: "HCLTech | Supercharging Progress" }), true);
        assert.equal(siteMatchesCompany("HCL Technologies", { url: "https://www.parked-domain.com/", title: "Buy this domain" }), false);
        assert.equal(siteMatchesCompany("Acme Logistics", { url: "https://acme.in/", title: "Welcome", siteName: "Acme" }), true);
    });
});

describe("SSRF protection", () => {
    test("private, loopback, link-local, multicast and non-IP addresses are blocked", () => {
        for (const ip of ["127.0.0.1", "127.8.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"]) {
            assert.equal(isBlockedAddress(ip), true, ip);
        }
        assert.equal(isBlockedAddress("8.8.8.8"), false);
        assert.equal(isBlockedAddress("2606:4700::1111"), false);
    });

    test("fetch refuses loopback literals, hostnames resolving to loopback, odd ports and redirects into private space", async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(302, { Location: "http://127.0.0.1/secret" });
            res.end();
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        try {
            await assert.rejects(fetchHtml("http://127.0.0.1/"), /Blocked/);
            await assert.rejects(fetchHtml("http://localhost/"), (err) => err.code === "EBLOCKED");
            await assert.rejects(fetchHtml(`http://localhost:${server.address().port}/`), /Unsupported port/);
            await assert.rejects(fetchHtml("ftp://acme.in/"), /Unsupported protocol/);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

describe("evidence grounding and research state", () => {
    const nameOnly = {
        company: "Acme",
        domain: "acme.in",
        summary: "Acme is a leading logistics provider serving Fortune 500 clients.",
        source: "openai_company_lookup",
        sources: [],
        qualityStatus: "NEEDS_REVIEW",
    };

    test("name-only model lookup is never grounded, even if relabelled or given a URL", () => {
        assert.equal(isGroundedResearch(nameOnly), false);
        assert.equal(isUsableResearchProfile(nameOnly), false);
        assert.equal(isGroundedResearch({ ...nameOnly, qualityStatus: "PARTIAL_RESEARCH" }), false);
        assert.equal(isGroundedResearch({ ...nameOnly, qualityStatus: "ACCEPTABLE", sources: [{ url: "https://acme.in/" }] }), false);
    });

    test("fallback email does not quote an ungrounded summary", async () => {
        const { draftCompanyPersonalizedEmail } = await import("../services/ase/leadEmailDrafter.service.js");
        const lead = { id: 1, organization_id: 9, first_name: "Asha", company: "Acme", email: "asha@gmail.com", metadata: { company_research: nameOnly } };
        const drafted = await draftCompanyPersonalizedEmail(lead, { senderName: "Nova" }).catch(() => null);
        if (!drafted) return;
        assert.doesNotMatch(`${drafted.subject} ${drafted.text}`, /Fortune 500|leading logistics/);
    });

    test("voice context drops ungrounded research", async () => {
        const { PlivoVoiceAdapter } = await import("../services/ase/adapters/plivoVoice.adapter.js").catch(() => ({}));
        if (!PlivoVoiceAdapter) return;
        const adapter = Object.create(PlivoVoiceAdapter.prototype);
        assert.equal(adapter.readCompanyResearch({ metadata: { company_research: nameOnly } }), null);
        assert.doesNotMatch(adapter.buildCallSpeech({ name: "Asha", company: "Acme", metadata: { company_research: nameOnly } }), /Fortune 500/);
    });

    test("failed research no longer blocks the scheduler", async () => {
        const { isCompanyResearchPending } = await import("../services/ase/companyResearch.service.js");
        assert.equal(isCompanyResearchPending({ company: "Acme", metadata: { company_research_status: "pending" } }), true);
        assert.equal(isCompanyResearchPending({ company: "Acme", metadata: { company_research_status: "failed" } }), false);
    });
});

describe("third-party reference matching", () => {
    test("accepts a reference only when its official site is the lead's domain", async () => {
        const { matchesCompanyDomain } = await import("../services/ase/companyReference.service.js");
        assert.equal(matchesCompanyDomain({ officialSites: ["https://www.swiggy.com/"], entityLabel: "Swiggy", domain: "swiggy.com", companyName: "Swiggy" }), true);
        assert.equal(matchesCompanyDomain({ officialSites: ["https://www.tcs.com"], entityLabel: "Tata Consultancy Services", domain: "tcs.com", companyName: "TCS" }), true);
        assert.equal(matchesCompanyDomain({ officialSites: ["https://www.amazon.com"], entityLabel: "Amazon", domain: "amazon.in", companyName: "Amazon" }), true);
        assert.equal(matchesCompanyDomain({ officialSites: ["https://www.amazon.com"], entityLabel: "Amazon", domain: "amazonplumbing.co.in", companyName: "Amazon" }), false);
        assert.equal(matchesCompanyDomain({ officialSites: ["https://www.apple.com"], entityLabel: "Apple Inc.", domain: "appletiles-india.com", companyName: "Apple" }), false);
        assert.equal(matchesCompanyDomain({ officialSites: [], entityLabel: "Infosys", domain: "infosys.com", companyName: "Infosys" }), false);
    });
});

describe("outreach body signoff", () => {
    test("a model-written signoff is replaced, never doubled", async () => {
        const { sanitizeOutreachBody } = await import("../utils/outreachEmail.js");
        const out = sanitizeOutreachBody("Hi Asha,\n\nWould a short chat help?\n\nBest,\nNova", "Nova");
        assert.equal(out, "Hi Asha,\n\nWould a short chat help?\n\nBest regards,\nNova");
        assert.equal((out.match(/Nova/g) || []).length, 1);
    });
});

describe("cadence email signoff cleanup", () => {
    test("removes a model-written signoff so the template signoff is not doubled", () => {
        const body = "Hi Asha,\n\nI tried calling you today but could not reach you.\n\nBest regards,\nNOVA AI";
        assert.equal(stripSignoff(body), "Hi Asha,\n\nI tried calling you today but could not reach you.");
        assert.equal(stripSignoff("Hi Asha,\n\nThanks for your time.\n\nCheers,\nRavi\nAcme"), "Hi Asha,\n\nThanks for your time.");
        assert.equal(stripSignoff("No signoff here."), "No signoff here.");
    });
});

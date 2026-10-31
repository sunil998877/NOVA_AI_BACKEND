import { describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { extractPageFacts, fetchHtml, isBlockedAddress } from "../services/ase/companyWebsite.service.js";
import { cleanDomain, heuristicResearch, isUsableResearchProfile } from "../services/ase/companyResearch.service.js";
import { isGroundedResearch, stripSignoff } from "../services/ase/cadence/cadenceEmailDrafter.js";

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

describe("cadence email signoff cleanup", () => {
    test("removes a model-written signoff so the template signoff is not doubled", () => {
        const body = "Hi Asha,\n\nI tried calling you today but could not reach you.\n\nBest regards,\nNOVA AI";
        assert.equal(stripSignoff(body), "Hi Asha,\n\nI tried calling you today but could not reach you.");
        assert.equal(stripSignoff("Hi Asha,\n\nThanks for your time.\n\nCheers,\nRavi\nAcme"), "Hi Asha,\n\nThanks for your time.");
        assert.equal(stripSignoff("No signoff here."), "No signoff here.");
    });
});

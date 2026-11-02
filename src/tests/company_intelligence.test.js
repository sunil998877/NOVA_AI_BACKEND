import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifyPage, extractPageFacts, isPlaceholderPage, parseRobots, planCrawl, sitemapLocs } from "../modules/intelligence/providers/website.provider.js";
import { formatFirstName } from "../utils/outreachEmail.js";
import { detectTechnologies } from "../modules/intelligence/providers/techDetection.provider.js";
import { detectJobBoards, roleFamily, summarizeRoles } from "../modules/intelligence/providers/hiring.provider.js";
import { quoteIsOnPage, verifyItems } from "../modules/intelligence/services/extraction.service.js";
import { buildOutreachSignals, formatSignalsForPrompt } from "../modules/intelligence/services/signals.service.js";
import { presentProfile } from "../modules/intelligence/controllers/intelligence.controller.js";

describe("placeholder sites", () => {
    test("webmail logins, parked domains and default server pages are not company websites", () => {
        const sogo = extractPageFacts('<html><head><title>SOGo</title></head><body><form><input name="u"><input type="password" name="p"></form></body></html>', "https://itiltd.co.in/");
        assert.equal(isPlaceholderPage(sogo), true);
        const jsLogin = extractPageFacts('<title>ITI Limited - Official Email System</title><meta name="description" content="SOGo Web Interface">', "https://itiltd.co.in/");
        assert.equal(isPlaceholderPage(jsLogin), true);
        const login = extractPageFacts('<html><head><title>Sign in</title></head><body><form><input type=password></form></body></html>', "https://acme.in/");
        assert.equal(isPlaceholderPage(login), true);
        assert.equal(isPlaceholderPage(extractPageFacts("<title>Welcome to nginx!</title>", "https://acme.in/")), true);
        assert.equal(isPlaceholderPage(extractPageFacts("<title>This domain is for sale</title>", "https://acme.in/")), true);
    });

    test("a real homepage with a login box is still a company website", () => {
        const links = ["/about", "/pricing", "/products", "/customers"].map((h) => `<a href="${h}">x</a>`).join("");
        const real = extractPageFacts(`<title>Acme Payments - payment APIs</title><p>${"Acme builds payment APIs for Indian businesses. ".repeat(12)}</p>${links}<input type="password">`, "https://acme.in/");
        assert.equal(isPlaceholderPage(real), false);
        const mailVendor = extractPageFacts(`<title>MailCo - secure email system for business</title>${links}`, "https://mailco.in/");
        assert.equal(isPlaceholderPage(mailVendor), false);
    });

    test("greeting fallback stays lowercase", () => {
        assert.equal(formatFirstName("there"), "there");
        assert.equal(formatFirstName(""), "there");
        assert.equal(formatFirstName("priya"), "Priya");
    });
});

describe("crawl planning", () => {
    test("robots.txt: specific group wins, longest rule wins, allow wins ties", () => {
        const robots = parseRobots([
            "User-agent: *",
            "Disallow: /",
            "",
            "User-agent: NovaResearchBot",
            "Disallow: /pricing/internal",
            "Allow: /pricing",
            "Sitemap: https://acme.in/sitemap.xml",
        ].join("\n"));
        assert.equal(robots.isAllowed("/pricing"), true);
        assert.equal(robots.isAllowed("/pricing/internal/x"), false);
        assert.equal(robots.isAllowed("/about"), true);
        assert.deepEqual(robots.sitemaps, ["https://acme.in/sitemap.xml"]);
        const star = parseRobots("User-agent: *\nDisallow: /careers\nDisallow: /*.pdf$");
        assert.equal(star.isAllowed("/careers/eng"), false);
        assert.equal(star.isAllowed("/files/a.pdf"), false);
        assert.equal(star.isAllowed("/about"), true);
        assert.equal(parseRobots(null).isAllowed("/anything"), true);
    });

    test("pages are typed by path and deep blog-like paths are ignored", () => {
        assert.equal(classifyPage("https://acme.in/pricing"), "pricing");
        assert.equal(classifyPage("https://acme.in/customers/zeta"), "customers");
        assert.equal(classifyPage("https://acme.in/careers"), "careers");
        assert.equal(classifyPage("https://acme.in/products/billing"), "products");
        assert.equal(classifyPage("https://www.zoho.com/customers.html"), "customers");
        assert.equal(classifyPage("https://www.zoho.com/aboutus.html"), "about");
        assert.equal(classifyPage("https://acme.in/pricing.php"), "pricing");
        assert.equal(classifyPage("https://acme.in/blog/2024/post"), null);
        assert.equal(classifyPage("https://acme.in/customers/a/b/c/d"), null);
    });

    test("sitemaps in XML and plain-text form both yield URLs", () => {
        assert.deepEqual(sitemapLocs("<urlset><url><loc>https://a.in/pricing</loc></url></urlset>"), ["https://a.in/pricing"]);
        assert.deepEqual(sitemapLocs("https://a.in/pricing\nhttps://a.in/about\nnot a url"), ["https://a.in/pricing", "https://a.in/about"]);
        assert.deepEqual(sitemapLocs("<urlset></urlset>"), []);
    });

    test("plan respects per-type quotas, same-site only, and never revisits home", () => {
        const plan = planCrawl([
            "https://acme.in/",
            "https://acme.in/pricing",
            "https://www.acme.in/pricing/enterprise",
            "https://other.com/pricing",
            "https://acme.in/products/a", "https://acme.in/products/b", "https://acme.in/products/c", "https://acme.in/products/d",
            "https://acme.in/careers",
            "https://acme.in/brochure.pdf",
        ], "https://acme.in/");
        assert.equal(plan.filter((p) => p.pageType === "pricing").length, 1);
        assert.equal(plan.filter((p) => p.pageType === "products").length, 3);
        assert.ok(plan.every((p) => !p.url.includes("other.com") && !p.url.endsWith(".pdf")));
        assert.ok(!plan.some((p) => p.url === "https://acme.in/"));
    });

    test("page extraction keeps list items and job-board hints, skips nav and footer text", () => {
        const html = `<html><head><title>Acme</title><script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script></head>
<body><nav><p>Navigation paragraph that is long enough to count as content text here.</p></nav>
<ul><li>Real-time GPS tracking for every shipment</li></ul>
<footer><p>Footer paragraph that is long enough to count as content text here too.</p></footer></body></html>`;
        const page = extractPageFacts(html, "https://acme.in/");
        assert.deepEqual(page.listItems, ["Real-time GPS tracking for every shipment"]);
        assert.doesNotMatch(page.excerpt, /Navigation|Footer/);
        assert.ok(page.jobBoardHints.some((hint) => hint.includes("greenhouse.io")));
    });
});

describe("tech stack detection", () => {
    test("detects tools from script fingerprints with evidence", () => {
        const html = `<script src="//js.hs-scripts.com/123.js"></script><script src="https://widget.intercom.io/widget/x"></script><script src="https://js.stripe.com/v3"></script>`;
        const names = detectTechnologies(html, "https://acme.in/").map((t) => t.name);
        assert.deepEqual(names.sort(), ["HubSpot", "Intercom", "Stripe"]);
        assert.equal(detectTechnologies(html, "https://acme.in/")[0].evidenceUrl, "https://acme.in/");
    });

    test("mentioning a tool in text is not detection", () => {
        assert.deepEqual(detectTechnologies("<p>We integrate with HubSpot, Salesforce and WooCommerce.</p>", "u"), []);
    });
});

describe("hiring signals", () => {
    test("only boards linked by the company are detected; embed paths are not slugs", () => {
        const boards = detectJobBoards([
            "https://boards.greenhouse.io/embed/job_board/js?for=acme",
            "https://jobs.lever.co/acme-labs/1234",
            "https://boards.greenhouse.io/embed",
        ]);
        assert.deepEqual(boards.map((b) => `${b.board.provider}:${b.slug}`), ["greenhouse:acme", "lever:acme-labs"]);
    });

    test("SmartRecruiters boards are detected from careers links", () => {
        const boards = detectJobBoards(["https://careers.smartrecruiters.com/Freshworks/gtm"]);
        assert.deepEqual(boards.map((b) => `${b.board.provider}:${b.slug}`), ["smartrecruiters:Freshworks"]);
    });

    test("roles are grouped into families", () => {
        assert.equal(roleFamily("Senior Account Executive"), "sales");
        assert.equal(roleFamily("Backend Engineer"), "engineering");
        assert.deepEqual(summarizeRoles([{ title: "SDR" }, { title: "BDR" }, { title: "Chef" }]), { sales: 2, other: 1 });
    });
});

describe("evidence verification", () => {
    const pages = [
        { url: "https://acme.in/", pageType: "home", title: "Acme", excerpt: "Acme ships chilled goods across 40 cities with real-time tracking." },
        { url: "https://acme.in/customers", pageType: "customers", listItems: ["Zeta Foods cut spoilage with Acme cold chain"] },
    ];

    test("a fact survives only if its quote is on the cited page", () => {
        assert.equal(quoteIsOnPage("ships chilled goods across 40 cities", pages[0]), true);
        assert.equal(quoteIsOnPage("ships chilled goods across 400 cities", pages[0]), false);
        assert.equal(quoteIsOnPage("Zeta Foods cut spoilage", pages[0]), false);
        const { kept, rejected } = verifyItems([
            { name: "Zeta Foods", page: "P1", quote: "Zeta Foods cut spoilage with Acme cold chain" },
            { name: "Fortune 500 Co", page: "P1", quote: "Trusted by Fortune 500 Co" },
            { name: "Ghost", page: "P9", quote: "Zeta Foods cut spoilage" },
        ], pages, "customer", (item) => item.name);
        assert.deepEqual(kept.map((f) => f.value), ["Zeta Foods"]);
        assert.equal(kept[0].sourceUrl, "https://acme.in/customers");
        assert.equal(rejected.length, 2);
    });
});

describe("outreach signals", () => {
    const research = {
        summary: "Acme ships chilled goods.",
        source: "website_scrape",
        qualityStatus: "ACCEPTABLE",
        sources: [{ url: "https://acme.in/" }],
        facts: [
            { field: "customer", value: "Zeta Foods", sourceUrl: "https://acme.in/customers", verificationStatus: "verified" },
            { field: "product", value: "ColdTrack", sourceUrl: "https://acme.in/products", verificationStatus: "unverified" },
        ],
        technologies: [{ name: "HubSpot", category: "crm_marketing", evidenceUrl: "https://acme.in/" }, { name: "Next.js", category: "framework", evidenceUrl: "https://acme.in/" }],
        hiring: { totalOpenRoles: 5, byFamily: { sales: 3, engineering: 2 }, boardUrl: "https://jobs.lever.co/acme" },
        unverifiedHypothesis: { summary: "guess" },
    };

    test("every signal has a source and unverified facts are excluded", () => {
        const signals = buildOutreachSignals(research);
        assert.ok(signals.every((s) => s.sourceUrl));
        assert.ok(signals.some((s) => s.type === "hiring" && /5 open roles on their job board \(3 sales, 2 engineering\)/.test(s.text)));
        assert.ok(signals.some((s) => s.type === "tech" && s.text.includes("HubSpot") && !s.text.includes("Next.js")));
        assert.ok(!signals.some((s) => s.text.includes("ColdTrack")));
        assert.match(formatSignalsForPrompt(research), /source: https:\/\/acme\.in\/customers/);
    });

    test("a company's own product is not reported as a tool it runs", () => {
        const own = { ...research, company: "Razorpay", technologies: [{ name: "Razorpay", category: "payments", evidenceUrl: "https://razorpay.com/" }] };
        assert.ok(!buildOutreachSignals(own).some((s) => s.type === "tech"));
    });

    test("API presentation hides the unverified guess behind an explicit warning", () => {
        const view = presentProfile(research);
        assert.equal(view.grounded, true);
        assert.match(view.unverified.note, /Do not use in outreach/);
        assert.equal(view.unverifiedHypothesis, undefined);
    });
});

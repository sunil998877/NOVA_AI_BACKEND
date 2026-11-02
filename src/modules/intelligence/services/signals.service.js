const FAMILY_LABEL = {
    sales: "sales",
    customer_success: "customer success/support",
    marketing: "marketing",
    engineering: "engineering",
    data: "data",
    product_design: "product/design",
    operations: "operations",
    finance_legal: "finance/legal",
    people: "people/HR",
};
const OUTREACH_TECH = new Set(["crm_marketing", "chat_support", "ecommerce", "payments", "scheduling"]);

function normalizeName(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hostOf(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "web";
    }
}

function factsOf(research, field) {
    return (research?.facts || []).filter((fact) => fact.field === field && fact.verificationStatus === "verified");
}

// Evidence-backed hooks only: each signal carries the URL it came from.
export function buildOutreachSignals(research) {
    if (!research) return [];
    const signals = [];
    // The verbatim quote is used instead of the model's paraphrase, which can misstate relationships between real names.
    const events = factsOf(research, "web_event")
        .filter((fact) => fact.date && fact.evidenceExcerpt)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .slice(0, 3);
    for (const fact of events) {
        signals.push({ type: `news_${fact.category}`, text: `Published ${fact.date} on ${hostOf(fact.sourceUrl)}: "${fact.evidenceExcerpt}"`, sourceUrl: fact.sourceUrl });
    }
    for (const fact of factsOf(research, "update").slice(0, 2)) {
        signals.push({ type: "update", text: `Announced on their site (undated): ${fact.value}`, sourceUrl: fact.sourceUrl });
    }
    const hiring = research.hiring;
    if (hiring?.totalOpenRoles > 0) {
        const top = Object.entries(hiring.byFamily || {})
            .filter(([family]) => family !== "other")
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([family, count]) => `${count} ${FAMILY_LABEL[family] || family}`);
        signals.push({
            type: "hiring",
            text: `Hiring: ${hiring.totalOpenRoles} open roles on their job board${top.length ? ` (${top.join(", ")})` : ""}`,
            sourceUrl: hiring.boardUrl,
        });
    }
    const products = factsOf(research, "product").slice(0, 3);
    if (products.length) {
        signals.push({ type: "products", text: `Products on their site: ${products.map((f) => f.value).join("; ")}`, sourceUrl: products[0].sourceUrl });
    }
    const customers = factsOf(research, "customer").slice(0, 4);
    if (customers.length) {
        signals.push({ type: "customers", text: `Customers named on their site: ${customers.map((f) => f.value).join(", ")}`, sourceUrl: customers[0].sourceUrl });
    }
    const pricing = factsOf(research, "pricing")[0];
    if (pricing) signals.push({ type: "pricing", text: `Pricing: ${pricing.value}`, sourceUrl: pricing.sourceUrl });
    const own = normalizeName(research.company);
    const tools = (research.technologies || [])
        .filter((tech) => OUTREACH_TECH.has(tech.category))
        .filter((tech) => !own || !normalizeName(tech.name).includes(own))
        .slice(0, 4);
    if (tools.length) {
        signals.push({ type: "tech", text: `Their website runs: ${tools.map((t) => t.name).join(", ")}`, sourceUrl: tools[0].evidenceUrl });
    }
    return signals;
}

export function formatSignalsForPrompt(research) {
    const signals = buildOutreachSignals(research);
    if (!signals.length) return "";
    return [
        "Verified signals (pick at most one or two that connect to the seller facts; state them plainly, never exaggerate, never say what a tool is used for internally, never call an undated announcement recent or new):",
        ...signals.map((s) => `- ${s.text} [source: ${s.sourceUrl}]`),
    ].join("\n");
}

export function formatSignalsForVoice(research) {
    return buildOutreachSignals(research).map((s) => s.text).join(" | ").slice(0, 600);
}

export const UNKNOWN_INDUSTRY = "UNKNOWN";

const INDUSTRIES = [
    { key: "CYBERSECURITY", label: "Cybersecurity", keywords: ["cybersecurity", "cyber security", "infosec", "penetration testing", "threat detection", "security operations", "managed security"], opportunity: "reaching technical and security buyers with relevant, well-timed outreach", capabilities: ["company_research", "personalized_email", "follow_up_automation"] },
    { key: "AI_ML", label: "Artificial Intelligence and Machine Learning", keywords: ["artificial intelligence", "machine learning", "generative ai", "computer vision", "nlp", "llm", "deep learning"], opportunity: "researching and reaching the businesses most likely to adopt AI solutions", capabilities: ["company_research", "personalized_email", "engagement_tracking"] },
    { key: "SAAS", label: "SaaS and Cloud Computing", keywords: ["saas", "software as a service", "cloud platform", "cloud computing", "subscription software", "cloud-based"], opportunity: "following up with trial users and B2B prospects and seeing who is engaging", capabilities: ["engagement_tracking", "follow_up_automation", "personalized_email"] },
    { key: "IT_SOFTWARE", label: "IT and Software Development", keywords: ["software development", "it services", "it solutions", "app development", "web development", "custom software", "technology consulting", "software company", "digital transformation", "software"], opportunity: "B2B prospect research and personalized outreach to potential clients", capabilities: ["company_research", "personalized_email", "follow_up_automation"] },
    { key: "DIGITAL_MARKETING", label: "Digital Marketing and Advertising", keywords: ["digital marketing", "advertising", "performance marketing", "seo", "ppc", "social media marketing", "marketing agency", "ad agency", "branding agency"], opportunity: "managing campaign and prospect outreach for new client acquisition", capabilities: ["email_campaigns", "engagement_tracking", "personalized_email"] },
    { key: "ECOMMERCE_RETAIL", label: "E-commerce and Retail", keywords: ["e-commerce", "ecommerce", "online store", "retail", "d2c", "direct-to-consumer", "marketplace seller"], opportunity: "B2B partnership, wholesale and supplier outreach", capabilities: ["personalized_email", "lead_management", "follow_up_automation"] },
    { key: "MANUFACTURING", label: "Manufacturing and Industrial", keywords: ["manufactur", "industrial", "factory", "machinery", "oem", "fabrication", "industrial equipment", "components"], opportunity: "organizing distributor and business-buyer outreach and keeping follow-ups consistent", capabilities: ["lead_management", "follow_up_automation", "company_research"] },
    { key: "LOGISTICS", label: "Logistics and Transportation", keywords: ["logistics", "freight", "shipping", "transportation", "supply chain", "warehousing", "trucking", "courier", "3pl", "fleet"], opportunity: "business development and prospecting for new shipper and client accounts", capabilities: ["company_research", "follow_up_automation", "ai_voice_calling"] },
    { key: "HEALTHCARE", label: "Healthcare and Medical Services", keywords: ["healthcare", "health care", "hospital", "clinic", "medical", "pharma", "diagnostic", "healthtech", "patient"], opportunity: "B2B partnership outreach to providers, suppliers or institutions", capabilities: ["personalized_email", "follow_up_automation", "lead_management"], caution: "Keep to B2B partnership outreach. Never reference patients, health data or clinical outcomes." },
    { key: "EDUCATION", label: "Education and E-learning", keywords: ["education", "e-learning", "elearning", "edtech", "school", "university", "college", "online courses", "training institute", "learning platform"], opportunity: "institutional and partnership outreach to schools, colleges or corporate training teams", capabilities: ["personalized_email", "follow_up_automation", "engagement_tracking"] },
    { key: "FINANCIAL_SERVICES", label: "Financial Services and FinTech", keywords: ["financial services", "fintech", "bank", "banking", "insurance", "lending", "payments", "wealth management", "accounting", "nbfc", "investment"], opportunity: "business prospecting with controlled, reviewable follow-up workflows", capabilities: ["lead_management", "follow_up_automation", "personalized_email"], caution: "Never make financial promises or mention returns. Mention human review where relevant." },
    { key: "REAL_ESTATE", label: "Real Estate and Property Management", keywords: ["real estate", "property management", "realty", "properties", "brokerage", "property developer", "commercial property"], opportunity: "managing business leads and following up with them on time", capabilities: ["lead_management", "follow_up_automation", "ai_voice_calling"] },
    { key: "CONSTRUCTION", label: "Construction and Infrastructure", keywords: ["construction", "infrastructure", "contractor", "civil engineering", "epc", "builders", "interior fit-out"], opportunity: "outreach to developers, contractors and project owners with consistent follow-ups", capabilities: ["lead_management", "follow_up_automation", "company_research"] },
    { key: "RECRUITMENT", label: "Recruitment and Staffing", keywords: ["recruitment", "staffing", "talent acquisition", "headhunting", "executive search", "manpower", "placement agency", "hiring solutions"], opportunity: "business outreach to hiring companies and coordinated follow-up workflows", capabilities: ["personalized_email", "follow_up_automation", "company_research"] },
    { key: "CONSULTING", label: "Consulting and Professional Services", keywords: ["consulting", "consultancy", "advisory", "professional services", "management consulting", "business consulting"], opportunity: "researching potential clients and running personalized client outreach", capabilities: ["company_research", "personalized_email", "email_campaigns"] },
    { key: "TELECOM", label: "Telecommunications and Networking", keywords: ["telecom", "telecommunications", "networking", "isp", "broadband", "connectivity", "network infrastructure", "voip"], opportunity: "enterprise prospect outreach and follow-up across email and calls", capabilities: ["workflow_coordination", "follow_up_automation", "lead_management"] },
    { key: "HOSPITALITY_TRAVEL", label: "Hospitality and Travel", keywords: ["hospitality", "hotel", "resort", "travel", "tourism", "tour operator", "restaurant", "banquet", "events venue"], opportunity: "corporate client, event and travel-partner outreach", capabilities: ["personalized_email", "email_campaigns", "follow_up_automation"] },
    { key: "AUTOMOTIVE", label: "Automotive and Automobile Services", keywords: ["automotive", "automobile", "car dealership", "vehicle", "auto parts", "ev charging", "two-wheeler"], opportunity: "dealer, fleet and corporate-buyer outreach", capabilities: ["lead_management", "follow_up_automation", "ai_voice_calling"] },
    { key: "WHOLESALE_DISTRIBUTION", label: "Wholesale and Distribution", keywords: ["wholesale", "distribution", "distributor", "b2b supplier", "trading company", "importer", "exporter"], opportunity: "outreach to retailers, resellers and new trade accounts", capabilities: ["lead_management", "follow_up_automation", "email_campaigns"] },
    { key: "AGRI_FOOD", label: "Agriculture and Food Processing", keywords: ["agriculture", "agri", "farming", "food processing", "dairy", "agritech", "food products", "fmcg"], opportunity: "buyer, distributor and institutional-customer outreach", capabilities: ["lead_management", "follow_up_automation", "personalized_email"] },
    { key: "LEGAL_BUSINESS_SERVICES", label: "Legal and Business Services", keywords: ["law firm", "legal services", "attorneys", "advocates", "business services", "compliance services", "corporate services"], opportunity: "professional client outreach with careful, reviewable messaging", capabilities: ["personalized_email", "follow_up_automation", "lead_management"], caution: "Keep a formal tone and avoid any statement that could read as legal advice." },
    { key: "MEDIA_ENTERTAINMENT", label: "Media and Entertainment", keywords: ["media", "entertainment", "publishing", "production house", "film", "music", "broadcast", "streaming", "content studio"], opportunity: "sponsor, advertiser and partner outreach", capabilities: ["email_campaigns", "engagement_tracking", "personalized_email"] },
    { key: "B2B_AGENCY", label: "B2B Agency", keywords: ["agency", "studio", "creative agency", "design agency", "outsourcing", "bpo"], opportunity: "new client acquisition through researched, personalized outreach", capabilities: ["company_research", "personalized_email", "follow_up_automation"] },
];

const BY_KEY = new Map(INDUSTRIES.map((industry) => [industry.key, industry]));

function readObject(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return {};
    }
}

function countHits(text, keyword) {
    if (!text) return 0;
    const pattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi");
    return (text.match(pattern) || []).length;
}

function scoreIndustries(weightedTexts) {
    const scores = new Map();
    for (const industry of INDUSTRIES) {
        let score = 0;
        for (const { text, weight } of weightedTexts) {
            for (const keyword of industry.keywords) score += countHits(text, keyword) * weight * (keyword.includes(" ") ? 1.5 : 1);
        }
        if (score > 0) scores.set(industry.key, score);
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

export function industryProfile(key) {
    return BY_KEY.get(key) || null;
}

export function listKnownIndustries() {
    return INDUSTRIES.map(({ key, label }) => ({ key, label }));
}

export function analyzeIndustry(lead = {}, research = null) {
    const attrs = readObject(lead.segment_attributes);
    const meta = readObject(lead.metadata);
    const leadIndustry = String(lead.industry || attrs.industry || meta.industry || "").trim();
    const grounded = Boolean(research?.grounded);
    const researchIndustry = grounded ? String(research.industry || "").trim() : "";
    const researchText = grounded
        ? [research.summary, research.coreServices, research.targetAudience, ...(research.facts || []).map((fact) => fact.value)].filter(Boolean).join("\n")
        : "";

    const ranked = scoreIndustries([
        { text: researchIndustry.toLowerCase(), weight: 4 },
        { text: researchText.toLowerCase(), weight: 1 },
        { text: leadIndustry.toLowerCase(), weight: grounded ? 2 : 3 },
    ]);
    const [topKey, topScore] = ranked[0] || [];
    const secondScore = ranked[1]?.[1] || 0;
    const profile = topKey ? BY_KEY.get(topKey) : null;
    const fromResearch = Boolean(profile) && (countHitsAny(researchIndustry, profile) || countHitsAny(researchText, profile));
    const subIndustry = researchIndustry || leadIndustry || null;

    if (!profile) {
        return {
            key: UNKNOWN_INDUSTRY,
            label: subIndustry || "Industry not identified",
            subIndustry,
            known: false,
            verified: Boolean(researchIndustry),
            source: researchIndustry ? "research" : (leadIndustry ? "lead_record" : "none"),
            confidence: subIndustry ? 0.4 : 0,
            opportunity: subIndustry
                ? `outreach that fits how a ${subIndustry.toLowerCase()} business finds and follows up with its own customers or partners`
                : "researching prospects and keeping follow-ups consistent",
            capabilities: [],
            caution: null,
            keywords: subIndustry ? subIndustry.toLowerCase().match(/[a-z]{4,}/g) || [] : [],
        };
    }
    const confidence = Math.min(0.95, 0.45 + topScore / 20 - (secondScore && secondScore >= topScore * 0.8 ? 0.15 : 0));
    return {
        key: profile.key,
        label: profile.label,
        subIndustry,
        known: true,
        verified: fromResearch,
        source: fromResearch ? "research" : "lead_record",
        confidence: Number(confidence.toFixed(2)),
        opportunity: profile.opportunity,
        capabilities: profile.capabilities,
        caution: profile.caution || null,
        keywords: [...new Set([...profile.keywords.filter((keyword) => !keyword.includes(" ")), ...(subIndustry ? subIndustry.toLowerCase().match(/[a-z]{4,}/g) || [] : [])])],
    };
}

function countHitsAny(text, profile) {
    const lower = String(text || "").toLowerCase();
    return profile.keywords.some((keyword) => countHits(lower, keyword) > 0);
}

const SIGNATURES = [
    { name: "HubSpot", category: "crm_marketing", pattern: /js\.hs-scripts\.com|js\.hsforms\.net|js\.hs-analytics\.net|js\.hs-banner\.com|js\.hubspot\.com/i },
    { name: "Salesforce Account Engagement (Pardot)", category: "crm_marketing", pattern: /pi\.pardot\.com|go\.pardot\.com|cdn\.pardot\.com/i },
    { name: "Salesforce", category: "crm_marketing", pattern: /webto\.salesforce\.com|service\.force\.com\/embeddedservice|my\.salesforce-sites\.com|salesforceliveagent\.com/i },
    { name: "Marketo", category: "crm_marketing", pattern: /munchkin\.marketo\.net|\/js\/forms2\/js\/forms2|mktoForm_/i },
    { name: "Zoho CRM", category: "crm_marketing", pattern: /crm\.zoho\.(com|in|eu)\/crm\/WebForm|zcform/i },
    { name: "Zoho SalesIQ", category: "chat_support", pattern: /salesiq\.zoho\.(com|in|eu)/i },
    { name: "Intercom", category: "chat_support", pattern: /widget\.intercom\.io|js\.intercomcdn\.com/i },
    { name: "Drift", category: "chat_support", pattern: /js\.driftt\.com|js\.drift\.com/i },
    { name: "Zendesk", category: "chat_support", pattern: /static\.zdassets\.com|zopim\.com/i },
    { name: "Freshworks", category: "chat_support", pattern: /wchat\.freshchat\.com|widget\.freshworks\.com|fw-cdn\.com/i },
    { name: "Crisp", category: "chat_support", pattern: /client\.crisp\.chat/i },
    { name: "Tawk.to", category: "chat_support", pattern: /embed\.tawk\.to/i },
    { name: "Google Analytics", category: "analytics", pattern: /googletagmanager\.com\/gtag\/js|google-analytics\.com\/(analytics|ga)\.js/i },
    { name: "Google Tag Manager", category: "analytics", pattern: /googletagmanager\.com\/gtm\.js/i },
    { name: "Segment", category: "analytics", pattern: /cdn\.segment\.com\/analytics/i },
    { name: "Mixpanel", category: "analytics", pattern: /cdn\.mxpnl\.com|cdn4\.mxpnl\.com/i },
    { name: "Hotjar", category: "analytics", pattern: /static\.hotjar\.com/i },
    { name: "Microsoft Clarity", category: "analytics", pattern: /www\.clarity\.ms\/tag/i },
    { name: "LinkedIn Insight Tag", category: "advertising", pattern: /snap\.licdn\.com\/li\.lms-analytics/i },
    { name: "Meta Pixel", category: "advertising", pattern: /connect\.facebook\.net\/[^"']*fbevents\.js/i },
    { name: "Shopify", category: "ecommerce", pattern: /cdn\.shopify\.com|Shopify\.theme/i },
    { name: "WooCommerce", category: "ecommerce", pattern: /wp-content\/plugins\/woocommerce/i },
    { name: "Stripe", category: "payments", pattern: /js\.stripe\.com/i },
    { name: "Razorpay", category: "payments", pattern: /checkout\.razorpay\.com/i },
    { name: "Calendly", category: "scheduling", pattern: /assets\.calendly\.com|calendly\.com\/assets/i },
    { name: "WordPress", category: "cms", pattern: /\/wp-content\/|<meta[^>]+generator[^>]+WordPress/i },
    { name: "Webflow", category: "cms", pattern: /website-files\.com|data-wf-page=/i },
    { name: "Wix", category: "cms", pattern: /static\.wixstatic\.com/i },
    { name: "Next.js", category: "framework", pattern: /\/_next\/static\//i },
];

export function detectTechnologies(html, url) {
    const source = String(html || "");
    const found = [];
    for (const signature of SIGNATURES) {
        const match = signature.pattern.exec(source);
        if (!match) continue;
        found.push({
            name: signature.name,
            category: signature.category,
            evidence: match[0].slice(0, 80),
            evidenceUrl: url || null,
        });
    }
    return found;
}

export function mergeTechnologies(pages) {
    const merged = new Map();
    for (const page of pages || []) {
        for (const tech of page.technologies || []) {
            if (!merged.has(tech.name)) merged.set(tech.name, { ...tech, detectedAt: page.retrievedAt || new Date().toISOString() });
        }
    }
    return [...merged.values()];
}

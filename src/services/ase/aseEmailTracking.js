function cleanBase(url) {
    return String(url || "").trim().replace(/\/$/, "");
}

function isSafeHttpUrl(url) {
    try {
        const parsed = new URL(String(url));
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

function shouldSkipHref(href) {
    const value = String(href || "").trim();
    if (!value) return true;
    if (/^(mailto:|tel:|#|javascript:)/i.test(value)) return true;
    if (/\/api\/track(?:ing)?\//i.test(value)) return true;
    if (/unsubscribe/i.test(value)) return true;
    if (!/^https?:\/\//i.test(value)) return true;
    return false;
}

export function attachAseOpenPixel(html, leadId, token, baseUrl) {
    const base = cleanBase(baseUrl);
    if (!html || !leadId || !token || !base) return html || "";
    const src = `${base}/api/tracking/open/ase/${leadId}?t=${encodeURIComponent(token)}`;
    const pixel = `<img src="${src}" width="1" height="1" alt="" border="0" style="width:1px;height:1px;border:0;outline:none;text-decoration:none;display:block;" />`;
    if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${pixel}</body>`);
    return `${html}${pixel}`;
}

export function wrapAseTrackedLinks(html, leadId, token, baseUrl) {
    const base = cleanBase(baseUrl);
    if (!html || !leadId || !token || !base) {
        return { html: html || "", linkCount: 0 };
    }

    let linkCount = 0;
    const rewritten = String(html).replace(
        /<a\s+([^>]*?)href=(["'])(.*?)\2([^>]*?)>/gi,
        (match, prefix, quote, href, suffix) => {
            if (shouldSkipHref(href)) return match;
            if (!isSafeHttpUrl(href)) return match;
            linkCount += 1;
            const tracked = `${base}/api/tracking/click/ase/${leadId}?url=${encodeURIComponent(href)}&t=${encodeURIComponent(token)}`;
            return `<a ${prefix}href=${quote}${tracked}${quote}${suffix}>`;
        }
    );

    return { html: rewritten, linkCount };
}

export function prepareAseTrackedHtml(html, { leadId, token, baseUrl }) {
    const wrapped = wrapAseTrackedLinks(html, leadId, token, baseUrl);
    return {
        html: attachAseOpenPixel(wrapped.html, leadId, token, baseUrl),
        linkCount: wrapped.linkCount,
    };
}

export function isSafeRedirectUrl(url) {
    return isSafeHttpUrl(url);
}

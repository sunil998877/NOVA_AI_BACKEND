import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const FETCH_TIMEOUT_MS = Number(process.env.ASE_RESEARCH_FETCH_TIMEOUT_MS || 6000);
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const MAX_PAGES = 3;
const USER_AGENT = "NovaResearchBot/1.0 (+public company website summary)";
const SUBPAGE_PATTERN = /\/(about|about-us|company|who-we-are|services|solutions|products|what-we-do)\/?$/i;

export function isBlockedAddress(address) {
    const ip = String(address || "").replace(/^::ffff:/i, "");
    if (net.isIP(ip) === 0) return true;
    if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0" || ip === "::") return true;
    if (ip.startsWith("127.") || ip.startsWith("0.")) return true;
    if (ip.startsWith("169.254.") || ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
    if (ip.startsWith("172.")) {
        const second = Number(ip.split(".")[1]);
        if (second >= 16 && second <= 31) return true;
    }
    if (ip.startsWith("100.")) {
        const second = Number(ip.split(".")[1]);
        if (second >= 64 && second <= 127) return true;
    }
    if (net.isIPv4(ip) && Number(ip.split(".")[0]) >= 224) return true;
    const lower = ip.toLowerCase();
    if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) return true;
    return false;
}

// Validates every resolved address at connect time so DNS rebinding cannot reach private networks.
function safeLookup(hostname, options, callback) {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || 4 }];
        const blocked = list.find((a) => isBlockedAddress(a.address));
        if (!list.length || blocked) {
            const error = new Error(`Blocked address for ${hostname}`);
            error.code = "EBLOCKED";
            return callback(error);
        }
        if (options?.all) return callback(null, list);
        return callback(null, list[0].address, list[0].family);
    });
}

function requestOnce(url) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) return reject(new Error("Unsupported protocol"));
        if (parsed.port && !["80", "443"].includes(parsed.port)) return reject(new Error("Unsupported port"));
        if (net.isIP(parsed.hostname) && isBlockedAddress(parsed.hostname)) return reject(new Error("Blocked address"));
        const client = parsed.protocol === "https:" ? https : http;
        const req = client.get(url, {
            lookup: safeLookup,
            timeout: FETCH_TIMEOUT_MS,
            headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
        }, (res) => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                return resolve({ redirect: new URL(res.headers.location, url).toString(), status });
            }
            const type = String(res.headers["content-type"] || "");
            if (status !== 200 || !/text\/html|application\/xhtml/i.test(type)) {
                res.resume();
                return resolve({ status, body: null });
            }
            const chunks = [];
            let size = 0;
            res.on("data", (chunk) => {
                size += chunk.length;
                if (size > MAX_BYTES) {
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8"), url }));
            res.on("close", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8"), url }));
        });
        req.on("timeout", () => req.destroy(new Error("Fetch timeout")));
        req.on("error", reject);
    });
}

export async function fetchHtml(url) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const res = await requestOnce(current);
        if (res.redirect) {
            current = res.redirect;
            continue;
        }
        return res.body ? { url: res.url || current, html: res.body } : null;
    }
    return null;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decode(text) {
    return String(text || "")
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, code) => {
            if (code[0] === "#") {
                const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
                return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
            }
            return ENTITIES[code.toLowerCase()] ?? match;
        })
        .replace(/\s+/g, " ")
        .trim();
}

function metaContent(html, attr, value) {
    const tags = html.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of tags) {
        const key = tag.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, "i"));
        if (key && key[1].toLowerCase() === value) {
            const content = tag.match(/content\s*=\s*["']([^"']*)["']/i);
            if (content) return decode(content[1]);
        }
    }
    return "";
}

export function extractPageFacts(html, url) {
    const source = String(html || "");
    const body = source
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ");
    const title = decode((source.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").slice(0, 200);
    const description = (metaContent(source, "name", "description") || metaContent(source, "property", "og:description")).slice(0, 400);
    const siteName = metaContent(source, "property", "og:site_name").slice(0, 120);
    const headings = [...body.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)]
        .map((m) => decode(m[1].replace(/<[^>]+>/g, " ")))
        .filter((h) => h.length >= 3 && h.length <= 160)
        .slice(0, 6);
    const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
        .map((m) => decode(m[1].replace(/<[^>]+>/g, " ")))
        .filter((p) => p.length >= 60)
        .slice(0, 4);
    const base = new URL(url);
    const links = [...new Set([...source.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)]
        .map((m) => {
            try {
                const link = new URL(m[1], base);
                return link.hostname === base.hostname && SUBPAGE_PATTERN.test(link.pathname) ? `${link.origin}${link.pathname}` : null;
            } catch {
                return null;
            }
        })
        .filter(Boolean))];
    return {
        url,
        title,
        description,
        siteName,
        headings,
        excerpt: paragraphs.join(" ").slice(0, 1200),
        links,
        retrievedAt: new Date().toISOString(),
    };
}

export async function fetchCompanySite(domain) {
    if (!domain) return [];
    let home = null;
    for (const origin of [`https://${domain}`, `https://www.${domain}`]) {
        try {
            const res = await fetchHtml(origin);
            if (res?.html) {
                home = extractPageFacts(res.html, res.url);
                break;
            }
        } catch {}
    }
    if (!home || (!home.title && !home.description && !home.excerpt)) return [];
    const pages = [home];
    for (const link of home.links.slice(0, MAX_PAGES - 1)) {
        try {
            const res = await fetchHtml(link);
            if (res?.html) pages.push(extractPageFacts(res.html, res.url));
        } catch {}
    }
    return pages.map(({ links, ...page }) => page);
}

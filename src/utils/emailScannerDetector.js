const SCANNER_SIGNATURES = [
    /GoogleImageProxy/i,
    /YahooMailProxy/i,
    /AppleWebKit.*Safari.*(Preload|Privacy)/i,
    /bingpreview/i,
    /facebookexternalhit/i,
    /Outlook-iOS|Outlook-Android/i,
    /Thunderbird.*Prefetch/i,
    /Bot|Crawler|Spider|Headless|Preview|Wget|Curl|python-requests/i,
];

export function detectEmailScanner(userAgent, ipAddress = null) {
    if (!userAgent || typeof userAgent !== "string") {
        return { isScanner: false, scannerType: null };
    }

    const ua = userAgent.trim();

    if (/GoogleImageProxy/i.test(ua)) {
        return { isScanner: true, scannerType: "GOOGLE_IMAGE_PROXY" };
    }

    if (/YahooMailProxy/i.test(ua)) {
        return { isScanner: true, scannerType: "YAHOO_PROXY" };
    }

    if (/AppleWebKit/i.test(ua) && /Macintosh.*10_15_7/i.test(ua) && !/Chrome|Firefox/i.test(ua)) {
        return { isScanner: true, scannerType: "APPLE_PRIVACY_PROXY" };
    }

    for (const pattern of SCANNER_SIGNATURES) {
        if (pattern.test(ua)) {
            return { isScanner: true, scannerType: "AUTOMATED_SCANNER" };
        }
    }

    return { isScanner: false, scannerType: null };
}

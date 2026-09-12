import { env } from "../config/env.js";
import { fetchWithTimeout } from "../utils/fetch.js";

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function getCache(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
        cache.delete(key);
        return null;
    }
    return item.data;
}

function setCache(key, data) {
    cache.set(key, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS,
    });
}

export const twitterService = {
    async searchChannels({ q, pageToken, maxResults = 12, minSubscribers, maxSubscribers }) {
        const token = env.twitterBearerToken;
        if (!token) {
            return {
                platform: "twitter",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
                error: "Twitter/X API token is not configured. Please add TWITTER_BEARER_TOKEN to your backend environment to search live X creators.",
            };
        }

        const query = String(q || "").trim();
        if (!query) {
            return {
                platform: "twitter",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
            };
        }

        const safeLimit = Math.min(Math.max(Number(maxResults) || 12, 1), 50);
        const cacheKey = `tw:${query}:${pageToken || ""}:${safeLimit}:${minSubscribers || ""}:${maxSubscribers || ""}`;
        const cached = getCache(cacheKey);
        if (cached) {
            return cached;
        }

        const url = new URL("https://api.twitter.com/2/users/by");
        url.searchParams.set("usernames", query.replace(/^@/, ""));
        url.searchParams.set("user.fields", "description,profile_image_url,public_metrics,location,verified");

        let res;
        try {
            res = await fetchWithTimeout(
                url.toString(),
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                },
                15_000
            );
        } catch (fetchErr) {
            return {
                platform: "twitter",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
                error: fetchErr.message || "Network error while connecting to Twitter API",
            };
        }

        if (!res.ok) {
            const errJson = await res.json().catch(() => ({}));
            return {
                platform: "twitter",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
                error: errJson?.detail || errJson?.title || `Twitter API returned status ${res.status}`,
            };
        }

        const json = await res.json();
        const users = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];

        let normalized = users.map((user) => {
            const followers = user.public_metrics?.followers_count || null;
            const desc = user.description || "";
            const emailMatch = desc.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            const extractedEmail = emailMatch ? emailMatch[0].toLowerCase() : null;

            return {
                platform: "twitter",
                platformUserId: String(user.id),
                name: user.name,
                username: user.username ? `@${user.username}` : null,
                email: extractedEmail,
                description: user.description || null,
                profileImage: user.profile_image_url ? user.profile_image_url.replace("_normal", "_400x400") : null,
                profileUrl: user.username ? `https://x.com/${user.username}` : null,
                subscribers: followers,
                followers: followers,
                videoCount: user.public_metrics?.tweet_count || null,
                viewCount: null,
                location: user.location || null,
                engagementRate: null,
            };
        });

        if (minSubscribers !== undefined && minSubscribers !== null && minSubscribers !== "") {
            const min = Number(minSubscribers);
            if (!Number.isNaN(min)) {
                normalized = normalized.filter((c) => c.followers !== null && c.followers >= min);
            }
        }

        if (maxSubscribers !== undefined && maxSubscribers !== null && maxSubscribers !== "") {
            const max = Number(maxSubscribers);
            if (!Number.isNaN(max)) {
                normalized = normalized.filter((c) => c.followers !== null && c.followers <= max);
            }
        }

        const result = {
            platform: "twitter",
            data: normalized,
            nextPageToken: null,
            prevPageToken: null,
            totalResults: normalized.length,
        };

        setCache(cacheKey, result);
        return result;
    },
};

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

export const instagramService = {
    async searchChannels({ q, pageToken, maxResults = 12, minSubscribers, maxSubscribers }) {
        const apiKey = env.instagramApiKey;
        if (!apiKey) {
            return {
                platform: "instagram",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
                error: "Instagram API key is not configured. Please add INSTAGRAM_API_KEY or RAPIDAPI_KEY to your backend environment to search live Instagram creators.",
            };
        }

        const query = String(q || "").trim();
        if (!query) {
            return {
                platform: "instagram",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
            };
        }

        const safeLimit = Math.min(Math.max(Number(maxResults) || 12, 1), 50);
        const cacheKey = `ig:${query}:${pageToken || ""}:${safeLimit}:${minSubscribers || ""}:${maxSubscribers || ""}`;
        const cached = getCache(cacheKey);
        if (cached) {
            return cached;
        }

        const url = new URL("https://instagram-scraper-api2.p.rapidapi.com/v1/search_users");
        url.searchParams.set("search_query", query);

        let res;
        try {
            res = await fetchWithTimeout(
                url.toString(),
                {
                    headers: {
                        "X-RapidAPI-Key": apiKey,
                        "X-RapidAPI-Host": "instagram-scraper-api2.p.rapidapi.com",
                    },
                },
                15_000
            );
        } catch (fetchErr) {
            return {
                platform: "instagram",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
                error: fetchErr.message || "Network error while connecting to Instagram API",
            };
        }

        if (!res.ok) {
            const errJson = await res.json().catch(() => ({}));
            return {
                platform: "instagram",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
                error: errJson?.message || `Instagram API returned status ${res.status}`,
            };
        }

        const json = await res.json();
        const users = Array.isArray(json?.data?.items)
            ? json.data.items
            : Array.isArray(json?.data)
                ? json.data
                : [];

        let normalized = users.map((user) => {
            const followers = Number(user.follower_count || user.followers || 0) || null;
            const username = user.username || user.handle || "";
            const bio = user.biography || user.bio || "";
            const emailMatch = bio.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            const extractedEmail = user.public_email || user.business_email || (emailMatch ? emailMatch[0].toLowerCase() : null);

            return {
                platform: "instagram",
                platformUserId: String(user.id || user.pk || username),
                name: user.full_name || user.name || username,
                username: username ? `@${username.replace(/^@/, "")}` : null,
                email: extractedEmail,
                description: user.biography || user.bio || null,
                profileImage: user.profile_pic_url || user.profile_pic_url_hd || null,
                profileUrl: username ? `https://www.instagram.com/${username.replace(/^@/, "")}` : null,
                subscribers: followers,
                followers: followers,
                videoCount: Number(user.media_count) || null,
                viewCount: null,
                location: null,
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
            platform: "instagram",
            data: normalized.slice(0, safeLimit),
            nextPageToken: null,
            prevPageToken: null,
            totalResults: normalized.length,
        };

        setCache(cacheKey, result);
        return result;
    },
};

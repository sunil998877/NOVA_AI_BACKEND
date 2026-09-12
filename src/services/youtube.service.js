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

export const youtubeService = {
    async searchChannels({ q, pageToken, maxResults = 12, minSubscribers, maxSubscribers }) {
        const apiKey = env.youtubeApiKey;
        if (!apiKey) {
            return {
                platform: "youtube",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
                error: "YouTube API key is not configured. Please add YOUTUBE_API_KEY in Backend/.env to discover live creators.",
            };
        }

        const query = String(q || "").trim();
        if (!query) {
            return {
                platform: "youtube",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
            };
        }

        const safeLimit = Math.min(Math.max(Number(maxResults) || 12, 1), 50);
        const cacheKey = `yt:${query}:${pageToken || ""}:${safeLimit}:${minSubscribers || ""}:${maxSubscribers || ""}`;
        const cached = getCache(cacheKey);
        if (cached) {
            return cached;
        }

        const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
        searchUrl.searchParams.set("part", "snippet");
        searchUrl.searchParams.set("type", "channel");
        searchUrl.searchParams.set("q", query);
        searchUrl.searchParams.set("maxResults", String(safeLimit));
        searchUrl.searchParams.set("key", apiKey);
        if (pageToken) {
            searchUrl.searchParams.set("pageToken", String(pageToken));
        }

        let searchRes;
        try {
            searchRes = await fetchWithTimeout(searchUrl.toString(), {}, 15_000);
        } catch (fetchErr) {
            return {
                platform: "youtube",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
                error: fetchErr.message || "Network error while connecting to YouTube API",
            };
        }

        if (!searchRes.ok) {
            const errorJson = await searchRes.json().catch(() => ({}));
            const apiMessage = errorJson?.error?.message || `YouTube API error (${searchRes.status})`;
            return {
                platform: "youtube",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
                error: searchRes.status === 403
                    ? "YouTube API quota has been exceeded or key is unauthorized. Please verify your YouTube API key."
                    : apiMessage,
            };
        }

        const searchData = await searchRes.json();
        const items = Array.isArray(searchData.items) ? searchData.items : [];
        const channelIds = items
            .map((item) => item.id?.channelId || item.snippet?.channelId)
            .filter(Boolean);

        if (channelIds.length === 0) {
            const result = {
                platform: "youtube",
                data: [],
                nextPageToken: searchData.nextPageToken || null,
                prevPageToken: searchData.prevPageToken || null,
                totalResults: searchData.pageInfo?.totalResults || 0,
            };
            setCache(cacheKey, result);
            return result;
        }

        const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
        detailsUrl.searchParams.set("part", "snippet,statistics");
        detailsUrl.searchParams.set("id", channelIds.join(","));
        detailsUrl.searchParams.set("key", apiKey);

        let detailsRes;
        try {
            detailsRes = await fetchWithTimeout(detailsUrl.toString(), {}, 15_000);
        } catch (fetchErr) {
            return {
                platform: "youtube",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
                error: fetchErr.message || "Network error while fetching channel details",
            };
        }

        if (!detailsRes.ok) {
            const errorJson = await detailsRes.json().catch(() => ({}));
            return {
                platform: "youtube",
                data: [],
                nextPageToken: null,
                prevPageToken: null,
                totalResults: 0,
                error: errorJson?.error?.message || "Failed to fetch YouTube channel details",
            };
        }

        const detailsData = await detailsRes.json();
        const detailMap = new Map();
        for (const ch of detailsData.items || []) {
            detailMap.set(ch.id, ch);
        }

        let normalized = items.map((item) => {
            const channelId = item.id?.channelId || item.snippet?.channelId;
            const details = detailMap.get(channelId);
            const snippet = details?.snippet || item.snippet;
            const stats = details?.statistics || {};

            const subs = stats.hiddenSubscriberCount
                ? null
                : (stats.subscriberCount !== undefined && stats.subscriberCount !== null
                    ? Number(stats.subscriberCount)
                    : null);

            const vCount = stats.videoCount !== undefined && stats.videoCount !== null ? Number(stats.videoCount) : null;
            const vwCount = stats.viewCount !== undefined && stats.viewCount !== null ? Number(stats.viewCount) : null;

            const thumbnail =
                snippet?.thumbnails?.high?.url ||
                snippet?.thumbnails?.medium?.url ||
                snippet?.thumbnails?.default?.url ||
                null;

            const desc = snippet?.description || "";
            const emailMatch = desc.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            const extractedEmail = emailMatch ? emailMatch[0].toLowerCase() : null;

            return {
                platform: "youtube",
                platformUserId: channelId,
                name: snippet?.title || "Unknown Channel",
                username: snippet?.customUrl || null,
                email: extractedEmail,
                description: snippet?.description || null,
                profileImage: thumbnail,
                profileUrl: `https://www.youtube.com/channel/${channelId}`,
                subscribers: subs,
                followers: subs,
                videoCount: vCount,
                viewCount: vwCount,
                location: snippet?.country || null,
                engagementRate: null,
            };
        });

        if (minSubscribers !== undefined && minSubscribers !== null && minSubscribers !== "") {
            const min = Number(minSubscribers);
            if (!Number.isNaN(min)) {
                normalized = normalized.filter((c) => c.subscribers !== null && c.subscribers >= min);
            }
        }

        if (maxSubscribers !== undefined && maxSubscribers !== null && maxSubscribers !== "") {
            const max = Number(maxSubscribers);
            if (!Number.isNaN(max)) {
                normalized = normalized.filter((c) => c.subscribers !== null && c.subscribers <= max);
            }
        }

        const result = {
            platform: "youtube",
            data: normalized,
            nextPageToken: searchData.nextPageToken || null,
            prevPageToken: searchData.prevPageToken || null,
            totalResults: searchData.pageInfo?.totalResults || normalized.length,
        };

        setCache(cacheKey, result);
        return result;
    },
};

import { youtubeService } from "./youtube.service.js";
import { instagramService } from "./instagram.service.js";
import { twitterService } from "./twitter.service.js";

export const influencerService = {
    async search({ platform = "youtube", q, pageToken, maxResults, minSubscribers, maxSubscribers }) {
        const targetPlatform = String(platform || "youtube").toLowerCase();

        if (targetPlatform === "youtube") {
            return youtubeService.searchChannels({ q, pageToken, maxResults, minSubscribers, maxSubscribers });
        }

        if (targetPlatform === "instagram") {
            return instagramService.searchChannels({ q, pageToken, maxResults, minSubscribers, maxSubscribers });
        }

        if (targetPlatform === "twitter") {
            return twitterService.searchChannels({ q, pageToken, maxResults, minSubscribers, maxSubscribers });
        }

        if (targetPlatform === "all") {
            try {
                return await youtubeService.searchChannels({ q, pageToken, maxResults, minSubscribers, maxSubscribers });
            } catch (err) {
                return {
                    platform: "all",
                    data: [],
                    nextPageToken: null,
                    prevPageToken: null,
                    totalResults: 0,
                    error: err.message,
                };
            }
        }

        throw new Error(`Unsupported platform: ${platform}`);
    },
};

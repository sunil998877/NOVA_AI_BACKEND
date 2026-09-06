import OpenAI from "openai";
import { env } from "../../config/env.js";

let client;

export const getOpenAiClient = () => {
    if (!env.openaiApiKey) return null;
    client ||= new OpenAI({
        apiKey: env.openaiApiKey,
        timeout: env.openaiTimeoutMs,
        maxRetries: 2,
    });
    return client;
};

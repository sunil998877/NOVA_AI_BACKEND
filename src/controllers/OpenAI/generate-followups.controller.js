import { asyncHandler } from "../../utils/asyncHandler.js";
import { getOpenAiClient } from "./client.js";

export const generateFollowups = asyncHandler(async (req, res) => {
    const { subject, body } = req.body;
    if (!subject || !body) {
        return res.status(400).json({ error: "subject and body are required" });
    }

    const client = getOpenAiClient();
    if (!client) {
        return res.status(500).json({ error: "OPENAI_API_KEY is not configured" });
    }

    const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                role: "system",
                content:
                    "You are NOVA. Write exactly 4 follow-up emails as a JSON array of objects with subject and body. No extra commentary.",
            },
            {
                role: "user",
                content: `Original subject: ${subject}\nOriginal body:\n${body}`,
            },
        ],
    });

    const raw = completion.choices[0]?.message?.content || "[]";
    let data;
    try {
        data = JSON.parse(raw);
        if (!Array.isArray(data)) throw new Error("Follow-ups must be an array");
    } catch {
        return res.status(502).json({ error: "OpenAI returned invalid follow-up data" });
    }

    return res.status(200).json({ data, error: null });
});

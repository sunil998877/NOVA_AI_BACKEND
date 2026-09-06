import { Conversation } from "../../models/conversation.model.js";
import { Message } from "../../models/message.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { getOpenAiClient } from "./client.js";

export const generateMessage = asyncHandler(async (req, res) => {
    const { prompt, conversationId } = req.body;
    if (!conversationId) {
        return res.status(400).json({ error: "Missing conversationId parameter." });
    }
    if (!prompt) {
        return res.status(400).json({ error: "prompt is required" });
    }

    const conversation = await Conversation.findOwned(conversationId, req.user.id);
    if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
    }

    const client = getOpenAiClient();
    if (!client) {
        return res.status(500).json({ error: "OPENAI_API_KEY is not configured" });
    }

    const signature = req.user.fullName
        ? `If you generate an email draft, end with: "Best regards, ${req.user.fullName}${req.user.organization ? `, ${req.user.organization}` : ""}".`
        : "";

    const systemMessage = {
        role: "system",
        content: `You are NOVA, an expert email marketing copywriter. ${signature}`,
    };

    let aiMessages = [systemMessage];
    if (req.body.context) {
        const history = await Message.findByConversation(conversation.id);
        const tail = history
            .slice(-30)
            .filter((item) => item.role === "user" || item.role === "assistant");
        aiMessages = aiMessages.concat(
            tail.map((item) => ({ role: item.role, content: item.content }))
        );
    } else {
        aiMessages.push({ role: "user", content: prompt });
    }

    const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: aiMessages,
    });

    const data = completion.choices[0]?.message?.content || "No response received.";

    await Message.create({
        conversation_id: conversation.id,
        user_id: req.user.id,
        role: "user",
        content: prompt,
    });

    await Message.create({
        conversation_id: conversation.id,
        user_id: req.user.id,
        role: "assistant",
        content: data,
    });

    return res.status(200).json({
        data,
        threadId: conversation.thread_id,
        error: null,
    });
});

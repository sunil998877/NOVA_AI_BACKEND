import { asyncHandler } from "../../utils/asyncHandler.js";
import { Conversation } from "../../models/conversation.model.js";
import { Message } from "../../models/message.model.js";
import { Collaboration } from "../../models/collaboration.model.js";
import { Influencer } from "../../models/influencer.model.js";

export const listUserConversations = asyncHandler(async (req, res) => {
    let conversations = [];
    try {
        conversations = await Conversation.listInfluencerConversations(req.user.id);
    } catch (err) {
        console.warn("[ConversationController] listInfluencerConversations warning:", err.message);
    }

    try {
        const collabs = await Collaboration.listByUser(req.user.id, { limit: 100 });
        const existingIds = new Set(conversations.map((c) => String(c.id)));
        const existingInfluencerIds = new Set(
            conversations.map((c) => String(c.influencerId)).filter(Boolean)
        );

        for (const collab of collabs) {
            const collabInfId = String(collab.influencer_id || "");
            if (
                !existingIds.has(String(collab.id)) &&
                (!collabInfId || !existingInfluencerIds.has(collabInfId))
            ) {
                conversations.push({
                    id: Number(collab.id),
                    campaignId: null,
                    influencerId: collab.influencer_id ? Number(collab.influencer_id) : null,
                    userId: Number(collab.user_id),
                    status: collab.status || "active",
                    title: `Outreach to ${collab.influencer_name}`,
                    influencerName: collab.influencer_name,
                    influencerUsername: collab.influencer_username || "",
                    platform: collab.platform || "youtube",
                    profileImage: collab.profile_image || null,
                    recipientEmail: collab.recipient_email || "",
                    unreadCount: 0,
                    lastMessage: collab.subject || collab.message || "Collaboration initiated",
                    lastMessageAt: collab.createdAt,
                    lastSenderType: "system",
                    accessToken: collab.access_token,
                });
            }
        }
    } catch (_) {}

    conversations.sort(
        (a, b) => new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime()
    );

    return res.status(200).json({
        success: true,
        data: conversations,
    });
});

export const getConversationDetails = asyncHandler(async (req, res) => {
    const { conversationId } = req.params;
    let conv = await Conversation.findForParticipant(conversationId, {
        id: req.user.id,
        role: "user",
    });

    if (!conv) {
        const collab = await Collaboration.findById(conversationId, req.user.id);
        if (collab) {
            conv = {
                id: collab.id,
                userId: collab.user_id,
                influencerId: collab.influencer_id,
                status: collab.status,
                title: `Outreach to ${collab.influencer_name}`,
                influencerName: collab.influencer_name,
                influencerUsername: collab.influencer_username,
                platform: collab.platform,
                profileImage: collab.profile_image,
                recipientEmail: collab.recipient_email,
                accessToken: collab.access_token,
            };
        }
    }

    if (!conv) {
        return res.status(404).json({ error: "Conversation not found or access denied" });
    }

    return res.status(200).json({
        success: true,
        data: conv,
    });
});

export const createOrFindConversation = asyncHandler(async (req, res) => {
    const { campaignId, influencerId, title } = req.body;

    const resolvedInfluencerId = influencerId ? Number(influencerId) : null;
    const resolvedCampaignId = campaignId ? Number(campaignId) : null;

    let convTitle = title;
    if (resolvedInfluencerId) {
        let inf = null;
        try {
            inf = await Influencer.findById(resolvedInfluencerId);
        } catch (_) {}
        convTitle = title || (inf ? `Chat with ${inf.name}` : "Influencer Chat");
    } else if (resolvedCampaignId) {
        convTitle = title || "Campaign Discussion";
    } else {
        convTitle = title || "AI Copilot";
    }

    const conv = await Conversation.findOrCreate({
        campaignId: resolvedCampaignId,
        influencerId: resolvedInfluencerId,
        userId: req.user.id,
        title: convTitle,
    });

    return res.status(200).json({
        success: true,
        data: conv,
        ...conv,
    });
});

export const getConversationMessages = asyncHandler(async (req, res) => {
    const { conversationId } = req.params;
    const { before, limit = 50 } = req.query;

    const messages = await Message.findByConversation(conversationId, {
        before: before ? Number(before) : null,
        limit: Number(limit) || 50,
    });

    return res.status(200).json({
        success: true,
        data: messages,
        count: messages.length,
    });
});

export const markConversationRead = asyncHandler(async (req, res) => {
    const { conversationId } = req.params;
    await Message.markAsRead(conversationId, "user");

    return res.status(200).json({
        success: true,
        message: "Messages marked as read",
    });
});

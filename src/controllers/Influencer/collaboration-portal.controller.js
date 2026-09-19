import { asyncHandler } from "../../utils/asyncHandler.js";
import { query } from "../../config/db.js";
import { Collaboration } from "../../models/collaboration.model.js";
import { CollaborationMessage } from "../../models/collaboration-message.model.js";
import { Influencer } from "../../models/influencer.model.js";

export const getPortalByToken = asyncHandler(async (req, res) => {
    const { token } = req.params;
    if (!token || !token.trim()) {
        return res.status(400).json({ error: "Collaboration token is required" });
    }

    const collab = await Collaboration.findByToken(token.trim());
    if (!collab) {
        return res.status(404).json({ error: "Collaboration proposal not found or link has expired" });
    }

    CollaborationMessage.markAsRead(collab.id, "influencer").catch(() => {});

    const [extraInfluencer, messages] = await Promise.all([
        (collab.influencer_id || collab.recipient_email)
            ? Influencer.findProfile({
                id: collab.influencer_id,
                email: collab.recipient_email,
                username: collab.influencer_username,
                name: collab.influencer_name,
            }).catch(() => null)
            : Promise.resolve(null),
        CollaborationMessage.findByCollaborationId(collab.id).catch(() => []),
    ]);

    return res.status(200).json({
        collaboration: {
            id: collab.id,
            influencerId: collab.influencer_id,
            influencerName: collab.influencer_name,
            influencerUsername: collab.influencer_username,
            platform: collab.platform,
            profileImage: collab.profile_image || extraInfluencer?.profile_image,
            profileUrl: collab.profile_url || extraInfluencer?.profile_url,
            recipientEmail: collab.recipient_email || extraInfluencer?.email,
            subscribers: extraInfluencer?.subscribers || null,
            category: extraInfluencer?.category || null,
            location: extraInfluencer?.location || null,
            subject: collab.subject,
            message: collab.message,
            status: collab.status,
            whatsappNumber: collab.whatsapp_number,
            createdAt: collab.createdAt,
        },
        messages,
    });
});

export const sendPortalMessage = asyncHandler(async (req, res) => {
    const { token } = req.params;
    const { content } = req.body;

    if (!token || !token.trim()) {
        return res.status(400).json({ error: "Collaboration token is required" });
    }

    if (!content || !String(content).trim()) {
        return res.status(400).json({ error: "Message content cannot be empty" });
    }

    const collab = await Collaboration.findByToken(token.trim());
    if (!collab) {
        return res.status(404).json({ error: "Collaboration proposal not found" });
    }

    const newMsg = await CollaborationMessage.create({
        collaborationId: collab.id,
        senderType: "influencer",
        senderName: collab.influencer_name || "Creator",
        content: String(content).trim(),
    });

    if (collab.status === "sent" || collab.status === "contacted") {
        try {
            await Collaboration.updateStatusByToken(token.trim(), "negotiating");
            if (collab.influencer_id && collab.user_id) {
                await Influencer.updateStatus(collab.influencer_id, collab.user_id, {
                    status: "negotiating",
                    lastContact: new Date(),
                });
            }
        } catch (_) { }
    }

    return res.status(201).json({
        success: true,
        message: newMsg,
    });
});

export const getMarketerMessages = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { influencerId } = req.query;

    let collab = null;
    if (id && id !== "latest") {
        collab = await Collaboration.findById(id, req.user.id);
    } else if (influencerId) {
        collab = await Collaboration.findLatestByInfluencerAndUser(influencerId, req.user.id);
    }

    if (!collab) {
        return res.status(200).json({
            collaboration: null,
            messages: [],
            unreadCount: 0,
        });
    }

    await CollaborationMessage.markAsRead(collab.id, "marketer");

    const messages = await CollaborationMessage.findByCollaborationId(collab.id);

    return res.status(200).json({
        collaboration: collab,
        messages,
        unreadCount: 0,
    });
});

export const sendMarketerMessage = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { content } = req.body;

    if (!content || !String(content).trim()) {
        return res.status(400).json({ error: "Message content cannot be empty" });
    }

    const collab = await Collaboration.findById(id, req.user.id);
    if (!collab) {
        return res.status(404).json({ error: "Collaboration not found" });
    }

    const senderName = req.user.fullName || "NOVA Partnerships Team";
    const newMsg = await CollaborationMessage.create({
        collaborationId: collab.id,
        senderType: "marketer",
        senderName,
        content: String(content).trim(),
    });

    return res.status(201).json({
        success: true,
        message: newMsg,
    });
});

export const getMarketerConversations = asyncHandler(async (req, res) => {
    const collabs = await Collaboration.listByUser(req.user.id, { limit: 100 });

    const conversations = await Promise.all(
        collabs.map(async (collab) => {
            let unreadCount = 0;
            let messages = [];
            try {
                unreadCount = await CollaborationMessage.countUnread(collab.id, "marketer");
                messages = await CollaborationMessage.findByCollaborationId(collab.id);
            } catch (_) { }

            const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
            return {
                ...collab,
                unreadCount,
                lastMessage: lastMsg?.content || collab.subject || "Collaboration initiated",
                lastMessageAt: lastMsg?.createdAt || collab.createdAt,
                lastSender: lastMsg?.senderType || "system",
                totalMessages: messages.length,
            };
        })
    );

    conversations.sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));

    return res.status(200).json({
        success: true,
        data: conversations,
    });
});

export const getChatCount = asyncHandler(async (req, res) => {
    await CollaborationMessage.ensureTable();
    const rows = await query(
        `SELECT
            COUNT(DISTINCT CASE WHEN cm.sender_type = 'influencer' THEN COALESCE(ch.influencer_id, ch.recipient_email, ch.id) END) AS influencers_count,
            COUNT(CASE WHEN cm.sender_type = 'influencer' THEN 1 END) AS total_messages,
            COUNT(CASE WHEN cm.sender_type = 'influencer' AND cm.read_at IS NULL THEN 1 END) AS unread_count
         FROM collaboration_history ch
         INNER JOIN collaboration_messages cm ON ch.id = cm.collaboration_id
         WHERE ch.user_id = ?`,
        [req.user.id]
    );

    const unread = Number(rows[0]?.unread_count || 0);
    const total = Number(rows[0]?.total_messages || 0);
    const influencers = Number(rows[0]?.influencers_count || 0);

    return res.status(200).json({
        success: true,
        unreadCount: unread,
        totalMessages: total,
        influencersCount: influencers,
        count: unread > 0 ? unread : total,
    });
});


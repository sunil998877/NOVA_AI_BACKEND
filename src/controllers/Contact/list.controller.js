import { Contact } from "../../models/contact.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const listContacts = asyncHandler(async (req, res) => {
    const { q = "", page = 1, limit = 50 } = req.query;
    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = (safePage - 1) * safeLimit;

    const [contacts, total] = await Promise.all([
        Contact.list({ q, skip, limit: safeLimit }),
        Contact.count(q),
    ]);

    return res.status(200).json({
        data: contacts,
        total,
        page: safePage,
        limit: safeLimit,
    });
});

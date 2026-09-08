import { Contact } from "../../models/contact.model.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

export const createContact = asyncHandler(async (req, res) => {
    const { name, email, company } = req.body;

    if (!name || !String(name).trim()) {
        return res.status(400).json({ error: "Name is required" });
    }
    if (!email || !String(email).trim()) {
        return res.status(400).json({ error: "Email is required" });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(String(email).trim())) {
        return res.status(400).json({ error: "Invalid email format" });
    }

    const contact = await Contact.upsert({
        name: String(name).trim(),
        email: String(email).trim(),
        company: company ? String(company).trim() : null,
    });

    return res.status(200).json({ data: contact });
});

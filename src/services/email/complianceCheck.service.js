import { Suppression } from "../../models/suppression.model.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function checkRecipientCompliance(orgId, recipient) {
    const email = String(recipient?.email || recipient?.recipientEmail || "").toLowerCase().trim();
    if (!email || !EMAIL_REGEX.test(email)) {
        return { eligible: false, reason: "INVALID_EMAIL" };
    }

    if (recipient?.do_not_contact || recipient?.dnc) {
        return { eligible: false, reason: "DNC_FLAGGED" };
    }

    if (recipient?.email_consent?.status === "DENIED") {
        return { eligible: false, reason: "CONSENT_DENIED" };
    }

    const domain = email.split("@")[1];
    const isSuppressed = await Suppression.isSuppressed(Number(orgId || 1), {
        email,
        phone: recipient?.phone || null,
        domain,
    });

    if (isSuppressed) {
        return { eligible: false, reason: isSuppressed.reason || "SUPPRESSION_LIST_MATCH" };
    }

    return { eligible: true };
}

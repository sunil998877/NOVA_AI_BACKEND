export function formatFirstName(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.toLowerCase() === "there") return "there";
    return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function bodyToHtml(text) {
    return `<p>${String(text || "").replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</p>`;
}

export function sanitizeOutreachBody(text, senderName = "NOVA AI") {
    if (!text) return "";
    let out = String(text)
        .replace(/\[Your Name\]/gi, "")
        .replace(/\[Name\]/gi, "")
        .replace(/Your Name/g, "")
        .replace(/NOVVA AI/gi, senderName)
        .replace(/\r\n/g, "\n");

    out = out.replace(/^(Dear|Hi|Hello)\s+([A-Za-z]+)/i, (_, greeting, name) => {
        const g = greeting.charAt(0).toUpperCase() + greeting.slice(1).toLowerCase();
        return `${g} ${formatFirstName(name)}`;
    });

    out = stripSignoff(out.replace(/\s*Best regards[\s\S]*$/i, ""));
    out = `${out}\n\nBest regards,\n${senderName}`;

    return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function stripSignoff(text) {
    let out = String(text || "").replace(/\r\n/g, "\n").trim();
    for (let i = 0; i < 2; i += 1) {
        out = out
            .replace(/\n+[ \t]*(thank you|thanks|regards|best|best regards|kind regards|warm regards|many thanks|sincerely|cheers)[ \t]*[,!.]?[ \t]*(\n[^\n]{0,60}){0,3}\s*$/i, "")
            .trim();
    }
    return out;
}

export function sanitizeOutreachEmail(email = {}, senderName = "NOVA AI") {
    const rawText = email.text
        || String(email.html || "")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n\n")
            .replace(/<[^>]+>/g, "");
    const text = sanitizeOutreachBody(rawText, senderName);
    return {
        ...email,
        subject: String(email.subject || "").replace(/\[Your Name\]/gi, "").replace(/Your Name/g, "").trim(),
        text,
        html: bodyToHtml(text),
    };
}

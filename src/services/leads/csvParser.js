export function parseCsv(text, customDelimiter = null) {
    const input = String(text || "").replace(/^\uFEFF/, "");
    let delimiter = customDelimiter;
    if (!delimiter) {
        const firstLine = input.split(/[\r\n]+/)[0] || "";
        const counts = {
            ",": (firstLine.match(/,/g) || []).length,
            ";": (firstLine.match(/;/g) || []).length,
            "\t": (firstLine.match(/\t/g) || []).length,
            "|": (firstLine.match(/\|/g) || []).length,
        };
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        delimiter = best && best[1] > 0 ? best[0] : ",";
    }

    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (inQuotes) {
            if (ch === '"') {
                if (input[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }

        if (ch === '"') {
            inQuotes = true;
        } else if (ch === delimiter) {
            row.push(field);
            field = "";
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && input[i + 1] === "\n") i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += ch;
        }
    }

    if (field !== "" || row.length) {
        row.push(field);
        rows.push(row);
    }

    return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}

const HEADER_ALIASES = {
    email: ["email", "e-mail", "email address", "work email", "mail"],
    name: ["name", "full name", "fullname", "contact name"],
    firstName: ["first name", "firstname", "first_name", "given name"],
    lastName: ["last name", "lastname", "last_name", "surname", "family name"],
    company: ["company", "company name", "organization", "organisation", "account"],
    phone: ["phone", "phone number", "mobile", "telephone", "contact number"],
    tags: ["tags", "tag", "labels", "segment"],
    priority: ["priority", "score", "lead priority", "rating"],
    whatsapp_number: ["whatsapp", "whatsapp number", "wa", "whatsapp_number"],
    industry: ["industry", "sector", "vertical"],
};

export function autoDetectMapping(headers) {
    const mapping = {};
    headers.forEach((header, index) => {
        const key = String(header).trim().toLowerCase();
        for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
            if (mapping[field] === undefined && aliases.includes(key)) {
                mapping[field] = index;
            }
        }
    });
    return mapping;
}

export function csvToLeads(text, columnMap = {}) {
    const rows = parseCsv(text);
    if (rows.length < 2) return { headers: rows[0] || [], leads: [] };

    const headers = rows[0].map((h) => String(h).trim());
    const mapping = autoDetectMapping(headers);

    for (const [key, val] of Object.entries(columnMap || {})) {
        if (!key || !val || val === "ignore") {
            if (val === "ignore") {
                const hIdx = headers.findIndex((h) => h.toLowerCase() === String(key).trim().toLowerCase());
                for (const [mField, mIdx] of Object.entries(mapping)) {
                    if (mIdx === hIdx) delete mapping[mField];
                }
            }
            continue;
        }
        const idxByVal = headers.findIndex((h) => h.toLowerCase() === String(val).trim().toLowerCase());
        if (idxByVal >= 0 && HEADER_ALIASES[key]) {
            mapping[key] = idxByVal;
            continue;
        }
        const idxByKey = headers.findIndex((h) => h.toLowerCase() === String(key).trim().toLowerCase());
        if (idxByKey >= 0 && HEADER_ALIASES[val]) {
            mapping[val] = idxByKey;
        }
    }

    const leads = rows.slice(1).map((cells) => {
        const lead = {};
        for (const [field, idx] of Object.entries(mapping)) {
            lead[field] = cells[idx] !== undefined ? String(cells[idx]).trim() : "";
        }
        return lead;
    });

    return { headers, mapping, leads };
}

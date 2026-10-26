const CITY_TIMEZONES = [
    [/san francisco|los angeles|seattle|california|ca\b|pacific/i, "America/Los_Angeles"],
    [/new york|boston|miami|atlanta|washington|ny\b|eastern/i, "America/New_York"],
    [/chicago|dallas|houston|austin|texas|central/i, "America/Chicago"],
    [/denver|phoenix|mountain/i, "America/Denver"],
    [/london|manchester|uk\b|britain/i, "Europe/London"],
    [/dubai|abu dhabi|uae/i, "Asia/Dubai"],
    [/singapore/i, "Asia/Singapore"],
    [/sydney|melbourne|australia/i, "Australia/Sydney"],
    [/pune|mumbai|delhi|bengaluru|bangalore|hyderabad|chennai|kolkata|india|maharashtra|karnataka|ist/i, "Asia/Kolkata"],
];

export function inferLeadTimezone(lead) {
    const explicit = lead?.metadata?.timezone || lead?.segment_attributes?.timezone || lead?.timezone;
    if (explicit && typeof explicit === "string") return explicit;
    const blob = [lead?.location, lead?.city, lead?.state, lead?.country, lead?.company].filter(Boolean).join(" ");
    for (const [pattern, tz] of CITY_TIMEZONES) {
        if (pattern.test(blob)) return tz;
    }
    return "Asia/Kolkata";
}

export function getLeadTimezone(lead, defaultTz = "Asia/Kolkata") {
    if (!lead) return defaultTz;
    return inferLeadTimezone(lead) || defaultTz;
}

export function getCurrentHourInTimezone(timezone = "Asia/Kolkata") {
    try {
        const str = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "numeric",
            hour12: false,
        }).format(new Date());
        return Number(str) % 24;
    } catch {
        return new Date().getHours();
    }
}

export function isWithinCallingHours(lead, options = {}) {
    const startHour = Number(options.startHour ?? process.env.ASE_CALLING_HOURS_START ?? 9);
    const endHour = Number(options.endHour ?? process.env.ASE_CALLING_HOURS_END ?? 20);
    const tz = getLeadTimezone(lead, options.timezone || process.env.ASE_CALLING_TIMEZONE || "Asia/Kolkata");
    const currentHour = getCurrentHourInTimezone(tz);

    return currentHour >= startHour && currentHour < endHour;
}

export function calculateNextCallingTime(lead, options = {}) {
    const startHour = Number(options.startHour ?? process.env.ASE_CALLING_HOURS_START ?? 9);
    const endHour = Number(options.endHour ?? process.env.ASE_CALLING_HOURS_END ?? 20);
    const delaySeconds = Number(options.delaySeconds ?? process.env.ASE_AUTO_CALL_DELAY_SECONDS ?? 30);
    const tz = getLeadTimezone(lead, options.timezone || process.env.ASE_CALLING_TIMEZONE || "Asia/Kolkata");

    const now = new Date();
    const candidateTime = new Date(now.getTime() + delaySeconds * 1000);

    let candidateHour;
    try {
        const str = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour: "numeric",
            hour12: false,
        }).format(candidateTime);
        candidateHour = Number(str) % 24;
    } catch {
        candidateHour = candidateTime.getHours();
    }

    if (candidateHour >= startHour && candidateHour < endHour) {
        return candidateTime;
    }

    const nextTime = new Date(candidateTime);
    if (candidateHour >= endHour) {
        nextTime.setDate(nextTime.getDate() + 1);
    }
    nextTime.setHours(startHour, 0, 0, 0);
    return nextTime;
}

export function getHourInTimezone(date, timezone = "Asia/Kolkata") {
    try {
        const str = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "numeric",
            hour12: false,
        }).format(date instanceof Date ? date : new Date(date));
        return Number(str) % 24;
    } catch {
        return new Date(date).getHours();
    }
}

function getTzParts(date, timezone) {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour) % 24,
        minute: Number(parts.minute),
    };
}

function zonedLocalTime(timezone, year, month, day, hour, minute) {
    const utc = Date.UTC(year, month - 1, day, hour, minute, 0);
    const asUtc = new Date(utc);
    const actual = getTzParts(asUtc, timezone);
    const desiredMinutes = hour * 60 + minute;
    const actualMinutes = actual.hour * 60 + actual.minute;
    return new Date(utc + (desiredMinutes - actualMinutes) * 60 * 1000);
}

function addDaysParts(parts, days) {
    const utc = Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0);
    const next = new Date(utc);
    return {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
    };
}

function leadSlotOffset(lead) {
    const seed = Number(lead?.id || 0) + String(lead?.email || lead?.name || "").length;
    return {
        hourShift: seed % 3,
        minute: (seed * 13) % 45,
    };
}

function pickLeadHour(lead, action, options = {}) {
    const status = String(options.status || lead?.status || "").toUpperCase();
    const engagement = Number(options.engagementScore || 0);
    const opens = Number(options.emailOpens || lead?.email_opens || 0);
    const offset = leadSlotOffset(lead);

    let hour = 11;
    if (status === "QUALIFIED" || status === "CALLBACK_SCHEDULED") hour = 10;
    else if (status === "INTERESTED") hour = 10;
    else if (status === "ENGAGED" || opens >= 2 || engagement >= 50) hour = 11;
    else if (action === "WAIT") hour = 15;
    else if (action === "CALL") hour = 16;
    else hour = 14;

    hour = Math.min(18, Math.max(9, hour + offset.hourShift));
    return { hour, minute: offset.minute };
}

export function buildOptimalSendWindow(lead, options = {}) {
    const action = String(options.action || "EMAIL").toUpperCase();
    const delayHours = Math.max(0, Number(options.delayHours || 0));
    const tz = getLeadTimezone(lead, options.timezone || process.env.ASE_CALLING_TIMEZONE || "Asia/Kolkata");
    const base = new Date(Date.now() + delayHours * 3600 * 1000);
    const parts = getTzParts(base, tz);
    const slot = pickLeadHour(lead, action, options);
    let day = { year: parts.year, month: parts.month, day: parts.day };

    if (action !== "WAIT" && (parts.hour > slot.hour || (parts.hour === slot.hour && parts.minute > slot.minute))) {
        day = addDaysParts(day, 1);
    }
    if (action === "WAIT" && delayHours >= 12) {
        day = addDaysParts(day, 1);
    }

    const start = zonedLocalTime(tz, day.year, day.month, day.day, slot.hour, slot.minute);
    const spanHours = action === "CALL" ? 1 : action === "WAIT" ? 2 : 2.5;
    const end = new Date(start.getTime() + spanHours * 3600 * 1000);
    return {
        start: start.toISOString(),
        end: end.toISOString(),
        timezone: tz,
        delayHours,
        action,
        localHour: slot.hour,
        localMinute: slot.minute,
    };
}

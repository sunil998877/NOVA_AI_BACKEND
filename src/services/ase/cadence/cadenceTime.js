const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map();

function formatter(timeZone) {
    if (!formatterCache.has(timeZone)) {
        formatterCache.set(timeZone, new Intl.DateTimeFormat("en-US", {
            timeZone,
            weekday: "short",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        }));
    }
    return formatterCache.get(timeZone);
}

export function isValidTimezone(timeZone) {
    if (!timeZone || typeof timeZone !== "string") return false;
    try {
        formatter(timeZone);
        return true;
    } catch {
        return false;
    }
}

export function zonedParts(date, timeZone) {
    const map = {};
    for (const part of formatter(timeZone).formatToParts(date)) map[part.type] = part.value;
    return {
        weekday: WEEKDAY[map.weekday] ?? 0,
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
        hour: Number(map.hour) % 24,
        minute: Number(map.minute),
    };
}

function zonedToUtc(timeZone, year, month, day, hour, minute) {
    const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
    const actual = zonedParts(new Date(guess), timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0);
    return new Date(guess + (guess - actualUtc));
}

function addDays(parts, days) {
    const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
    return {
        year: next.getUTCFullYear(),
        month: next.getUTCMonth() + 1,
        day: next.getUTCDate(),
        weekday: next.getUTCDay(),
    };
}

export function isInsideWindow(date, window, timeZone) {
    const parts = zonedParts(date, timeZone);
    return window.days.includes(parts.weekday)
        && parts.hour >= window.startHour
        && parts.hour < window.endHour;
}

export function alignToWindow(date, window, timeZone) {
    const at = date instanceof Date ? date : new Date(date);
    if (isInsideWindow(at, window, timeZone)) return at;

    const parts = zonedParts(at, timeZone);
    let cursor = { year: parts.year, month: parts.month, day: parts.day, weekday: parts.weekday };
    if (parts.hour >= window.endHour || !window.days.includes(parts.weekday)) {
        cursor = addDays(cursor, 1);
    }
    for (let i = 0; i < 8 && !window.days.includes(cursor.weekday); i += 1) {
        cursor = addDays(cursor, 1);
    }
    return zonedToUtc(timeZone, cursor.year, cursor.month, cursor.day, window.startHour, 0);
}

export function addMinutes(date, minutes) {
    return new Date(new Date(date).getTime() + Number(minutes || 0) * 60 * 1000);
}

export function addDaysToDate(date, days) {
    return new Date(new Date(date).getTime() + Number(days || 0) * 24 * 60 * 60 * 1000);
}

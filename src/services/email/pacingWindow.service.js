export function getPacingDelayMs(campaign) {
    const minSec = Math.max(1, Number(campaign?.min_delay_seconds ?? 5));
    const maxSec = Math.max(minSec, Number(campaign?.max_delay_seconds ?? 15));
    const randomSec = minSec + Math.random() * (maxSec - minSec);
    return Math.round(randomSec * 1000);
}

function parseTimeToMinutes(timeStr, fallbackMinutes) {
    if (!timeStr || typeof timeStr !== "string") return fallbackMinutes;
    const parts = timeStr.trim().split(":");
    if (parts.length < 2) return fallbackMinutes;
    const hours = parseInt(parts[0], 10);
    const mins = parseInt(parts[1], 10);
    if (isNaN(hours) || isNaN(mins)) return fallbackMinutes;
    return hours * 60 + mins;
}

export function isTimeInSendingWindow(campaign, targetDate = new Date()) {
    const tz = campaign?.timezone || "UTC";
    let formatted;
    try {
        formatted = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour12: false,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
        }).formatToParts(targetDate);
    } catch (_) {
        formatted = new Intl.DateTimeFormat("en-US", {
            timeZone: "UTC",
            hour12: false,
            weekday: "short",
            hour: "2-digit",
            minute: "2-digit",
        }).formatToParts(targetDate);
    }

    const partMap = {};
    for (const p of formatted) {
        partMap[p.type] = p.value;
    }

    const weekdayStr = partMap.weekday || "Mon";
    const dayNameToNum = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const currentDayNum = dayNameToNum[weekdayStr] ?? 1;

    let permittedDays = [1, 2, 3, 4, 5];
    if (campaign?.sending_days) {
        try {
            const parsed = typeof campaign.sending_days === "string" ? JSON.parse(campaign.sending_days) : campaign.sending_days;
            if (Array.isArray(parsed) && parsed.length > 0) {
                permittedDays = parsed.map(Number);
            }
        } catch (_) {}
    }

    if (!permittedDays.includes(currentDayNum)) {
        return false;
    }

    const currentHour = parseInt(partMap.hour, 10) || 0;
    const currentMin = parseInt(partMap.minute, 10) || 0;
    const currentTotalMins = currentHour * 60 + currentMin;

    const startMins = parseTimeToMinutes(campaign?.sending_window_start, 8 * 60);
    const endMins = parseTimeToMinutes(campaign?.sending_window_end, 18 * 60);

    if (startMins <= endMins) {
        return currentTotalMins >= startMins && currentTotalMins < endMins;
    } else {
        return currentTotalMins >= startMins || currentTotalMins < endMins;
    }
}

export function calculateNextWindowOpening(campaign, fromDate = new Date()) {
    let checkDate = new Date(fromDate.getTime());
    for (let step = 0; step < 168; step += 1) {
        checkDate = new Date(checkDate.getTime() + 15 * 60 * 1000);
        if (isTimeInSendingWindow(campaign, checkDate)) {
            return checkDate;
        }
    }
    return new Date(fromDate.getTime() + 60 * 60 * 1000);
}

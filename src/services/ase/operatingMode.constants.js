export const OPERATING_MODES = Object.freeze({
    FULLY_AUTOMATED: "FULLY_AUTOMATED",
    AI_RECOMMENDED: "AI_RECOMMENDED",
    HUMAN_ESCALATION: "HUMAN_ESCALATION",
});

export const ALLOWED_OPERATING_MODES = new Set(Object.values(OPERATING_MODES));

export function normalizeOperatingMode(mode) {
    const next = String(mode || "").toUpperCase();
    return ALLOWED_OPERATING_MODES.has(next) ? next : null;
}

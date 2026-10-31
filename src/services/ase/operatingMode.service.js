import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { OrgOperatingMode } from "../../models/org-operating-mode.model.js";
import {
    ALLOWED_OPERATING_MODES,
    OPERATING_MODES,
    normalizeOperatingMode,
} from "./operatingMode.constants.js";

export { ALLOWED_OPERATING_MODES, OPERATING_MODES, normalizeOperatingMode };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODE_PATH = path.resolve(__dirname, "../../models/ml/operating_mode.json");

const modeCache = new Map();

function readPersistedFile() {
    try {
        if (!fs.existsSync(MODE_PATH)) return null;
        const parsed = JSON.parse(fs.readFileSync(MODE_PATH, "utf-8"));
        return normalizeOperatingMode(parsed?.mode);
    } catch {
        return null;
    }
}

function writePersistedFile(mode) {
    try {
        fs.mkdirSync(path.dirname(MODE_PATH), { recursive: true });
        fs.writeFileSync(MODE_PATH, JSON.stringify({ mode, updated_at: new Date().toISOString() }));
    } catch (err) {
        console.warn("[ASE] Could not persist operating mode file:", err.message);
    }
}

function fileOrEnvFallback() {
    return readPersistedFile()
        || normalizeOperatingMode(process.env.ASE_OPERATING_MODE)
        || OPERATING_MODES.FULLY_AUTOMATED;
}

export function seedOperatingMode(orgId, mode) {
    const next = normalizeOperatingMode(mode);
    if (!next) {
        throw new Error(`Invalid operating mode: ${mode}. Allowed: ${[...ALLOWED_OPERATING_MODES].join(", ")}`);
    }
    modeCache.set(Number(orgId || 1), next);
    return next;
}

export function getCachedOperatingMode(orgId = 1) {
    const id = Number(orgId || 1);
    if (modeCache.has(id)) return modeCache.get(id);
    return fileOrEnvFallback();
}

export async function getOperatingMode(orgId = 1) {
    const id = Number(orgId || 1);
    if (modeCache.has(id)) return modeCache.get(id);
    try {
        const fromDb = await OrgOperatingMode.get(id);
        const mode = normalizeOperatingMode(fromDb) || fileOrEnvFallback();
        modeCache.set(id, mode);
        return mode;
    } catch {
        const fallback = fileOrEnvFallback();
        modeCache.set(id, fallback);
        return fallback;
    }
}

export async function setOperatingMode(orgId, mode) {
    const id = Number(arguments.length < 2 ? 1 : orgId);
    const nextMode = arguments.length < 2 ? orgId : mode;
    const next = seedOperatingMode(id, nextMode);
    try {
        await OrgOperatingMode.set(id, next);
    } catch (err) {
        console.warn("[ASE] Could not persist operating mode to org row:", err.message);
    }
    if (id === 1) writePersistedFile(next);
    return { success: true, mode: next, organizationId: id };
}

export function evaluateDispatch(action, { mode, approved = false, manual = false } = {}) {
    const act = String(action || "").toUpperCase();
    const current = normalizeOperatingMode(mode) || OPERATING_MODES.FULLY_AUTOMATED;

    if (act !== "EMAIL" && act !== "CALL") {
        return { allowed: true, reason: null, enqueue: false, assignRep: false, mode: current };
    }

    if (current === OPERATING_MODES.FULLY_AUTOMATED) {
        return { allowed: true, reason: null, enqueue: false, assignRep: false, mode: current };
    }

    if (current === OPERATING_MODES.AI_RECOMMENDED) {
        if (approved) {
            return { allowed: true, reason: null, enqueue: false, assignRep: false, mode: current };
        }
        return {
            allowed: false,
            reason: "Operating mode is AI_RECOMMENDED — waiting for rep approval",
            enqueue: true,
            assignRep: false,
            mode: current,
        };
    }

    if (current === OPERATING_MODES.HUMAN_ESCALATION) {
        if (manual) {
            return { allowed: true, reason: null, enqueue: false, assignRep: false, mode: current };
        }
        return {
            allowed: false,
            reason: "Operating mode is HUMAN_ESCALATION — outbound is paused for reps",
            enqueue: false,
            assignRep: true,
            mode: current,
        };
    }

    return { allowed: true, reason: null, enqueue: false, assignRep: false, mode: current };
}

export async function canAutoDispatch(action, options = {}) {
    const orgId = Number(options.organizationId || options.orgId || 1);
    const mode = options.mode || await getOperatingMode(orgId);
    return evaluateDispatch(action, { ...options, mode });
}

export function executionFlagsForMode(mode, { humanInitiated = false } = {}) {
    const current = normalizeOperatingMode(mode) || OPERATING_MODES.FULLY_AUTOMATED;
    if (current === OPERATING_MODES.FULLY_AUTOMATED) {
        return { force: true, approved: false, manual: false };
    }
    if (current === OPERATING_MODES.AI_RECOMMENDED) {
        return { force: false, approved: false, manual: false };
    }
    if (current === OPERATING_MODES.HUMAN_ESCALATION && humanInitiated) {
        return { force: true, approved: false, manual: true };
    }
    return { force: false, approved: false, manual: false };
}

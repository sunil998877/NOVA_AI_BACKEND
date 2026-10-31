import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { env } from "../../../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "../../../..");

let child = null;
let shuttingDown = false;
let restartTimer = null;
let watchdog = null;
let ensurePromise = null;

function serviceBase() {
    return String(env.aseMlUrl || "http://127.0.0.1:8091").replace(/\/$/, "");
}

async function isHealthy() {
    try {
        const response = await fetch(`${serviceBase()}/health`, { signal: AbortSignal.timeout(1500) });
        return response.ok;
    } catch {
        return false;
    }
}

function startChild() {
    if (child || shuttingDown) return;
    const port = new URL(serviceBase()).port || "8091";
    const args = ["-m", "uvicorn", "ml_service.main:app", "--host", "127.0.0.1", "--port", port];
    if (env.nodeEnv !== "production") args.push("--reload");
    child = spawn(
        "python",
        args,
        { cwd: backendRoot, stdio: "inherit", windowsHide: true }
    );
    child.on("error", (error) => {
        console.error("ASE decision model failed to start:", error.message);
        child = null;
    });
    child.on("exit", (code, signal) => {
        child = null;
        if (shuttingDown) return;
        console.error(`ASE decision model exited (${signal || code}). It will be started again.`);
        scheduleRestart(2000);
    });
    console.log(`Starting ASE decision model at ${serviceBase()}`);
}

function scheduleRestart(delayMs) {
    if (shuttingDown || restartTimer) return;
    restartTimer = setTimeout(() => {
        restartTimer = null;
        ensureMlService();
    }, delayMs);
    restartTimer.unref?.();
}

async function waitUntilHealthy(timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await isHealthy()) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return isHealthy();
}

async function ensureMlServiceOnce() {
    if (!watchdog && !shuttingDown) {
        watchdog = setInterval(() => {
            ensureMlService();
        }, 20000);
        watchdog.unref?.();
    }

    if (await isHealthy()) {
        if (!child) console.log(`ASE decision model already running at ${serviceBase()}`);
        return true;
    }
    startChild();
    const ready = await waitUntilHealthy(30000);
    if (ready) {
        console.log(`ASE decision model ready at ${serviceBase()}`);
        return true;
    }
    console.warn(`ASE decision model did not become healthy at ${serviceBase()} — using rules until it starts`);
    return false;
}

export async function ensureMlService() {
    if (!ensurePromise) {
        ensurePromise = ensureMlServiceOnce().finally(() => {
            ensurePromise = null;
        });
    }
    return ensurePromise;
}

export function stopMlService() {
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (watchdog) clearInterval(watchdog);
    if (child && !child.killed) {
        child.kill();
    }
}

process.on("exit", () => {
    if (child && !child.killed) {
        try {
            child.kill();
        } catch {}
    }
});

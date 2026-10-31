// Usage: node scripts/run-tests.js [unit|live|all] [file-filter]
// Live tests talk to the configured MySQL/HTTP stack; each runs in its own process with a hard timeout
// so one hung connection cannot stall the whole suite.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(root, "src", "tests");
const mode = process.argv[2] || "unit";
const filter = process.argv[3] || "";
const LIVE_MARKERS = /\bconnectDb\b|\bapp\.listen\(/;
const LIVE_TIMEOUT_MS = Number(process.env.LIVE_TEST_TIMEOUT_MS || 6 * 60 * 1000);

const files = readdirSync(testDir)
    .filter((name) => name.endsWith(".test.js") && name.includes(filter))
    .sort()
    .map((name) => ({ name, live: LIVE_MARKERS.test(readFileSync(join(testDir, name), "utf8")) }));

const unit = files.filter((f) => !f.live).map((f) => join("src", "tests", f.name));
const live = files.filter((f) => f.live).map((f) => join("src", "tests", f.name));
let failed = false;

if ((mode === "unit" || mode === "all") && unit.length) {
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...unit], { cwd: root, stdio: "inherit" });
    failed ||= run.status !== 0;
}

// A running API/worker with real Plivo credentials shares the DB and its scheduler sweep can claim a
// test lead's due step first and place a real call.
async function apiServerRunning() {
    const port = Number(process.env.PORT || 3001);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

if ((mode === "live" || mode === "all") && process.env.ALLOW_LIVE_WITH_SERVER !== "1" && await apiServerRunning()) {
    console.error("Live tests refused: a NOVA API server is running against the same database. Stop it (and any worker), or set ALLOW_LIVE_WITH_SERVER=1 if it has no telephony credentials.");
    process.exit(1);
}

if (mode === "live" || mode === "all") {
    const summary = [];
    for (const file of live) {
        const started = Date.now();
        const run = spawnSync(process.execPath, ["--test", "--test-force-exit", `--test-timeout=${LIVE_TIMEOUT_MS}`, file], {
            cwd: root,
            stdio: "inherit",
            timeout: LIVE_TIMEOUT_MS + 30000,
        });
        const status = run.error?.code === "ETIMEDOUT" ? "TIMEOUT" : run.status === 0 ? "PASS" : "FAIL";
        summary.push(`${status.padEnd(8)} ${file} (${Math.round((Date.now() - started) / 1000)}s)`);
        failed ||= status !== "PASS";
    }
    console.log(`\nLive test summary:\n${summary.join("\n")}`);
}

process.exit(failed ? 1 : 0);

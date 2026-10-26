import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");

execSync("python -m ml_service.train_heads", {
    cwd: backendRoot,
    stdio: "inherit",
    env: process.env,
});

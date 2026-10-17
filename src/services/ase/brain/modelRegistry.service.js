import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ModelRegistry {
    constructor() {
        this.modelDir = path.resolve(__dirname, "../../../models/ml");
        this.modelPath = path.join(this.modelDir, "lead_next_action.onnx");
        this.metaPath = path.join(this.modelDir, "lead_next_action_meta.json");
        this.mode = process.env.ASE_BRAIN_MODE || "ACTIVE";
    }

    getModelStatus() {
        const modelExists = fs.existsSync(this.modelPath);
        let metadata = null;

        if (fs.existsSync(this.metaPath)) {
            try {
                metadata = JSON.parse(fs.readFileSync(this.metaPath, "utf-8"));
            } catch (e) {
                metadata = { error: "Failed to parse metadata", details: e.message };
            }
        }

        return {
            mode: this.mode,
            isModelAvailable: modelExists,
            modelPath: this.modelPath,
            version: metadata?.version || "1.0.0",
            accuracy: metadata?.accuracy ?? null,
            totalSamples: metadata?.total_samples ?? null,
            updatedAt: metadata?.updated_at || null,
            features: metadata?.features || [],
            classes: metadata?.classes || { 0: "EMAIL", 1: "CALL", 2: "WAIT" },
        };
    }

    setMode(newMode) {
        const allowed = new Set(["RULES_ONLY", "SHADOW", "ACTIVE"]);
        if (!allowed.has(newMode)) {
            throw new Error(`Invalid brain mode: ${newMode}. Allowed: RULES_ONLY, SHADOW, ACTIVE`);
        }
        this.mode = newMode;
        return { success: true, mode: this.mode };
    }
}

export const modelRegistry = new ModelRegistry();

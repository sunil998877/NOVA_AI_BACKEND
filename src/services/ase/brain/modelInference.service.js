import * as ort from "onnxruntime-node";
import { modelRegistry } from "./modelRegistry.service.js";

class ModelInferenceService {
    constructor() {
        this.session = null;
        this.isInitializing = false;
        this.ACTION_MAP = {
            0: "EMAIL",
            1: "CALL",
            2: "WAIT",
        };
    }

    async init() {
        if (this.session) return this.session;
        if (this.isInitializing) {
            while (this.isInitializing) {
                await new Promise((r) => setTimeout(r, 40));
            }
            return this.session;
        }

        this.isInitializing = true;
        try {
            const status = modelRegistry.getModelStatus();
            if (!status.isModelAvailable) {
                throw new Error("ONNX model artifact not found");
            }

            this.session = await ort.InferenceSession.create(status.modelPath, {
                executionProviders: ["cpu"],
                graphOptimizationLevel: "all",
            });
            return this.session;
        } finally {
            this.isInitializing = false;
        }
    }

    async predict(features) {
        const status = modelRegistry.getModelStatus();

        if (status.mode === "RULES_ONLY" || !status.isModelAvailable) {
            return {
                available: false,
                reason: status.mode === "RULES_ONLY" ? "RULES_ONLY_MODE" : "MODEL_UNAVAILABLE",
            };
        }

        const start = performance.now();
        try {
            await this.init();

            const inputTensor = new ort.Tensor("float32", features.vector, [1, 5]);
            const results = await this.session.run({ float_input: inputTensor });

            const labelTensor = results.output_label || results.label;
            const winningClass = Number(labelTensor.data[0]);
            const action = this.ACTION_MAP[winningClass] || "EMAIL";

            let confidence = 0.85;
            let probMap = { EMAIL: 0.33, CALL: 0.33, WAIT: 0.33 };

            if (results.output_probability) {
                const probs = Array.from(results.output_probability.data);
                probMap = {
                    EMAIL: Number((probs[0] || 0).toFixed(3)),
                    CALL: Number((probs[1] || 0).toFixed(3)),
                    WAIT: Number((probs[2] || 0).toFixed(3)),
                };
                confidence = probMap[action] || confidence;
            }

            const latencyMs = Number((performance.now() - start).toFixed(2));

            if (isNaN(confidence) || confidence < 0 || confidence > 1) {
                confidence = 0.5;
            }

            return {
                available: true,
                action,
                confidence,
                probabilities: probMap,
                latencyMs,
                modelVersion: status.version,
                provider: "onnxruntime",
            };
        } catch (error) {
            return {
                available: false,
                error: error.message,
                latencyMs: Number((performance.now() - start).toFixed(2)),
            };
        }
    }
}

export const modelInferenceService = new ModelInferenceService();

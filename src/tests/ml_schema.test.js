import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FEATURE_NAMES, FEATURE_SCALES, FEATURE_SCHEMA_VERSION, buildScaledFeatureVector } from "../services/ase/brain/featureSchema.js";

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../models/ml/feature_schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));

test("Node and Python share the same 12-feature ML schema", () => {
    assert.equal(FEATURE_SCHEMA_VERSION, schema.feature_schema_version);
    assert.deepEqual(FEATURE_NAMES, schema.features);
    assert.deepEqual(FEATURE_SCALES, schema.scales);
    assert.equal(FEATURE_NAMES.length, 12);
    assert.equal(schema.architecture, "12-32-16-3");
});

test("Scaled inference vector stays 12 dimensions and in unit range", () => {
    const vector = buildScaledFeatureVector({
        emailOpens: 3,
        linkClicks: 1,
        emailAttempts: 1,
        voiceAttempts: 0,
        hoursSinceLastTouch: 30,
        engagementScore: 55,
        emailConsentAllowed: true,
        voiceConsentAllowed: true,
        priority: 70,
        status: "ENGAGED",
    });
    assert.equal(vector.length, 12);
    assert.ok([...vector].every((value) => value >= 0 && value <= 1));
});

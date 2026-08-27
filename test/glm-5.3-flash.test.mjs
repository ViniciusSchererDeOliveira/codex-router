import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";

// These assertions describe the checked-in registry and synthetic account
// fixtures, so the machine's own models, credentials, and quota history must
// not leak in; the imports are dynamic for that reason.
const testRoot = mkdtempSync(path.join(os.tmpdir(), "glm-5.3-flash-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG } = await import("../src/model-registry.mjs");

// GLM-5.3-Flash is published on multiple providers after the withdrawn Ox Alpha
// preview routes were removed. Each route uses the same upstream model id
// (except Venice which has a different id format), the same 1M context window,
// and the same low/high/max reasoning ladder that the model itself enforces.
const ROUTES = [
  ["commandcode/glm-5.3-flash", "z-ai/glm-5.3-flash"],
  ["nousresearch/glm-5.3-flash", "z-ai/glm-5.3-flash"],
  ["opencode-go/glm-5.3-flash", "glm-5.3-flash"],
  ["openrouter/glm-5.3-flash", "z-ai/glm-5.3-flash"],
  ["venice/glm-5.3-flash", "z-ai-glm-5-3-flash"],
  ["zai-coding/glm-5.3-flash", "glm-5.3-flash"],
];

test("every GLM-5.3-Flash route records the upstream id, window and ladder", () => {
  for (const [slug, upstreamModel] of ROUTES) {
    const model = MODEL_BY_SLUG.get(slug);
    assert.ok(model, `${slug} is missing from the registry`);
    assert.equal(model.upstreamModel, upstreamModel);
    assert.equal(model.listed, true);
    assert.deepEqual(model.reasoningLevels.map((level) => level.effort), ["low", "high", "max"]);
    assert.equal(model.defaultEffort, "max");
    assert.equal(model.contextWindow, 1_000_000);
    // autoCompact varies: Z.AI Coding uses 400K (proven conservative), opencode
    // Go and others inherited the same.
    assert.ok(model.autoCompact >= 400_000 && model.autoCompact <= 900_000);
    assert.deepEqual(model.inputModalities, slug === "opencode-go/glm-5.3-flash" ? ["text", "image"] : ["text"]);
  }
});

test("withdrawn Ox Alpha routes are absent, replaced by GLM-5.3-Flash", () => {
  for (const slug of [
    "commandcode/ox-alpha",
    "nousresearch/ox-alpha",
    "opencode-free/ox-alpha",
    "openrouter/ox-alpha",
    "venice/ox-alpha",
  ]) {
    assert.equal(MODEL_BY_SLUG.has(slug), false, `${slug} should not exist`);
  }
  // GLM-5.3-Flash replaces ox-alpha on these providers
  assert.equal(MODEL_BY_SLUG.has("commandcode/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("nousresearch/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("openrouter/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("venice/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("zai-coding/glm-5.3-flash"), true);
  assert.equal(MODEL_BY_SLUG.has("opencode-go/glm-5.3-flash"), true);
});

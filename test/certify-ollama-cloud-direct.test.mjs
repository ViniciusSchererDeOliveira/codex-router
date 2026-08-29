import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "certify-ollama-cloud-direct.mjs");

test("direct certification does not echo local state or credentials", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "ollama-certification-"));
  const privateState = path.join(testRoot, "private-router-state");
  const privateHome = path.join(testRoot, "private-codex-home");
  try {
    const result = spawnSync(
      process.execPath,
      [script, "ollama-cloud/glm-5.3", "--live", "--yes"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: privateHome,
          MODEL_ROUTER_STATE_DIR: privateState,
          CODEX_ROUTER_NO_DISCOVERY: "1",
          OLLAMA_API_KEY: "TEST_OLLAMA_CERT_SECRET",
          OLLAMA_CLOUD_API_KEY: "TEST_OLLAMA_CERT_SECRET",
        },
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Ollama Cloud credential unavailable/);
    assert.doesNotMatch(output, /TEST_OLLAMA_CERT_SECRET/);
    assert.doesNotMatch(output, /private-router-state|private-codex-home/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("direct certification rejects unregistered model input without echoing it", async () => {
  const { resolveTargetModel } = await import("../scripts/certify-ollama-cloud-direct.mjs");
  assert.deepEqual(resolveTargetModel("ollama-cloud/glm-5.3"), {
    slug: "ollama-cloud/glm-5.3",
    upstreamModel: "glm-5.3:cloud",
  });
  assert.deepEqual(resolveTargetModel("glm-5.3:cloud"), {
    slug: "ollama-cloud/glm-5.3",
    upstreamModel: "glm-5.3:cloud",
  });
  const secretLikeInput = "/private/router-state/OLLAMA_API_KEY=DO_NOT_PRINT";
  assert.throws(
    () => resolveTargetModel(secretLikeInput),
    /registered Ollama Cloud model slug or upstream model id/,
  );
});

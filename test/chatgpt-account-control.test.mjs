import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-account-control-"));
const env = {
  ...process.env,
  CODEX_HOME: stateDir,
  MODEL_ROUTER_STATE_DIR: stateDir,
};
const run = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(root, "src/control.mjs"), ...args], {
  env,
  encoding: "utf8",
}));

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

test("account selection persists without replacing another saved login", () => {
  writeFileSync(
    path.join(stateDir, "auth.json"),
    JSON.stringify({ tokens: { access_token: "current-token", account_id: "current" } }),
    { mode: 0o600 },
  );
  const added = run("chatgpt-account-pool", "add", "Secondary").account;
  mkdirSync(path.join(stateDir, "chatgpt-accounts", added.id), { recursive: true });
  writeFileSync(
    path.join(stateDir, "chatgpt-accounts", added.id, "auth.json"),
    JSON.stringify({ tokens: { access_token: "secondary-token", account_id: "secondary" } }),
    { mode: 0o600 },
  );
  const selected = run("chatgpt-account-pool", "select", added.id);
  assert.equal(selected.policy.selectedAccountId, added.id);
  const status = run("chatgpt-account-pool", "status");
  assert.equal(status.policy.mode, "switch");
  assert.equal(status.profile.desired, added.id);
  assert.equal(status.profile.pending, status.profile.running);
  assert.equal(status.accounts[added.id].label, "Secondary");
  assert.equal(status.accounts[added.id].state, "active");
  assert.equal(Object.keys(status.accounts).length, 2);
});

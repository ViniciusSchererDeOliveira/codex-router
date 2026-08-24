import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  chatGPTSubscriptionAccountAuthPath,
  chatGPTSubscriptionAccountHome,
  chatGPTSubscriptionAccountPoolSnapshot,
  chatGPTSubscriptionAccountStatus,
  createChatGPTSubscriptionAccount,
  readChatGPTAccountPoolState,
  removeChatGPTSubscriptionAccount,
  sanitizeChatGPTAccountPool,
  withChatGPTAccountPoolLock,
  writeChatGPTAccountPoolState,
} from "../src/chatgpt-account-pool.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-account-store-"));
  return { root, filePath: path.join(root, "accounts.json"), homesDir: path.join(root, "homes") };
}

test("saved accounts use isolated homes and never persist credentials in pool state", () => {
  const options = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  const state = readFileSync(options.filePath, "utf8");
  assert.match(account.id, /^acct_[A-Za-z0-9_-]+$/);
  assert.equal(chatGPTSubscriptionAccountHome(account.id, options), path.join(options.homesDir, account.id));
  assert.equal(readChatGPTAccountPoolState(options.filePath).accounts[account.id].subscription.status, "pending");
  assert.doesNotMatch(state, /access_token|refresh_token|id_token/);
});

test("account labels reuse the first free number after a removed account", () => {
  const options = fixture();
  const first = createChatGPTSubscriptionAccount(options);
  const second = createChatGPTSubscriptionAccount(options);
  removeChatGPTSubscriptionAccount(first.id, options);
  const next = createChatGPTSubscriptionAccount(options);
  assert.equal(first.label, "ChatGPT account 1");
  assert.equal(second.label, "ChatGPT account 2");
  assert.equal(next.label, "ChatGPT account 1");
});

test("snapshot exposes email and usable status from an isolated auth file", () => {
  const options = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  const payload = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken = `header.${payload({ email: "second@example.com" })}.signature`;
  writeFileSync(chatGPTSubscriptionAccountAuthPath(account.id, options), JSON.stringify({
    tokens: { access_token: "access-token", account_id: "account-2", id_token: idToken },
  }), { mode: 0o600 });
  const snapshot = chatGPTSubscriptionAccountPoolSnapshot(options);
  assert.equal(snapshot.accounts[account.id].subscription.email, "second@example.com");
  assert.equal(snapshot.accounts[account.id].subscription.usable, true);
  assert.equal(chatGPTSubscriptionAccountStatus(account.id, options).hasAccountId, true);
});

test("sanitization keeps account identity but never exposes credentials", () => {
  const state = {
    version: 1,
    policy: { enabled: true, mode: "pool", strategy: "round-robin", selectedAccountId: "acct_example_123456" },
    accounts: {
      acct_example_123456: {
        id: "acct_example_123456",
        state: "active",
        label: "Work",
        identity: { accountId: "openai-account-2", email: "work@example.com" },
        subscription: { status: "usable" },
        tokens: { access_token: "secret" },
      },
    },
  };
  const sanitized = sanitizeChatGPTAccountPool(state);
  assert.equal(sanitized.policy.mode, "switch");
  assert.equal(sanitized.accounts.acct_example_123456.identity.email, "work@example.com");
  assert.equal("tokens" in sanitized.accounts.acct_example_123456, false);
  assert.equal("strategy" in sanitized.policy, false);
});

test("account state writes are serialized across concurrent operations", async () => {
  const options = fixture();
  const first = createChatGPTSubscriptionAccount(options);
  const second = createChatGPTSubscriptionAccount(options);
  await Promise.all([
    withChatGPTAccountPoolLock(async () => {
      const state = readChatGPTAccountPoolState(options.filePath);
      state.policy.selectedAccountId = first.id;
      await new Promise((resolve) => setTimeout(resolve, 5));
      writeChatGPTAccountPoolState(state, options.filePath);
    }, options),
    withChatGPTAccountPoolLock(async () => {
      const state = readChatGPTAccountPoolState(options.filePath);
      state.policy.selectedAccountId = second.id;
      writeChatGPTAccountPoolState(state, options.filePath);
    }, options),
  ]);
  const selected = readChatGPTAccountPoolState(options.filePath).policy.selectedAccountId;
  assert.ok(selected === first.id || selected === second.id);
});

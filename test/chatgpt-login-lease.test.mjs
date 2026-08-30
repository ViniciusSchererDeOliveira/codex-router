import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CHATGPT_LOGIN_LEASE_MAX_AGE_MS,
  chatGPTLoginLeasePath,
  createChatGPTLoginLease,
} from "../src/chatgpt-login-lease.mjs";
import {
  chatGPTSubscriptionAccountHome,
  createChatGPTSubscriptionAccount,
  readChatGPTAccountPoolState,
} from "../src/chatgpt-account-pool.mjs";
import { removeChatGPTProfileAccount } from "../src/chatgpt-profile-switch.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-login-lease-"));
  const options = {
    filePath: path.join(root, "pool.json"),
    homesDir: path.join(root, "accounts"),
    primaryHome: path.join(root, "primary"),
    switchPath: path.join(root, "switch.json"),
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  };
  return { root, options };
}

test("core removal refuses a durable login owner after the GUI lifecycle is gone", async () => {
  const { options } = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  createChatGPTLoginLease(account.id, 4242, {
    homesDir: options.homesDir,
    identity: () => "owner-start-identity",
    now: 1_000,
  });
  await assert.rejects(
    removeChatGPTProfileAccount(account.id, {
      ...options,
      loginLeaseIdentity: () => "owner-start-identity",
      now: 2_000,
    }),
    /browser sign-in is in progress/i,
  );
  assert.ok(readChatGPTAccountPoolState(options.filePath).accounts[account.id]);
  assert.equal(existsSync(chatGPTSubscriptionAccountHome(account.id, options)), true);
  assert.equal(existsSync(chatGPTLoginLeasePath(account.id, options)), true);
});

test("a bounded stale login owner is cleaned before direct core removal", async () => {
  const { options } = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  createChatGPTLoginLease(account.id, 4242, {
    homesDir: options.homesDir,
    identity: () => "departed-owner",
    now: 1_000,
  });
  const result = await removeChatGPTProfileAccount(account.id, {
    ...options,
    loginLeaseIdentity: () => undefined,
    now: 1_000 + CHATGPT_LOGIN_LEASE_MAX_AGE_MS + 1,
  });
  assert.equal(result.removed.id, account.id);
  assert.equal(readChatGPTAccountPoolState(options.filePath).accounts[account.id], undefined);
  assert.equal(existsSync(chatGPTSubscriptionAccountHome(account.id, options)), false);
});

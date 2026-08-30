import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

test("exclusive durable ownership refuses a concurrent login and survives GUI restart", async () => {
  const { options } = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  const leaseModule = pathToFileURL(path.resolve("src/chatgpt-login-lease.mjs")).href;
  const ownerSource = `
    import { createChatGPTLoginLease } from ${JSON.stringify(leaseModule)};
    createChatGPTLoginLease(${JSON.stringify(account.id)}, process.pid, {
      homesDir: ${JSON.stringify(options.homesDir)}
    });
    process.stdout.write("ready\\n");
    setTimeout(() => {}, 30_000);
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerSource], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  owner.stdout.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("lease owner did not start")), 20_000);
    owner.once("error", reject);
    owner.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("ready\n")) {
        clearTimeout(timer);
        resolve();
      }
    });
    owner.once("close", (code) => reject(new Error(`lease owner exited early (${code})`)));
  });
  try {
    const contenderSource = `
      import { createChatGPTLoginLease } from ${JSON.stringify(leaseModule)};
      try {
        createChatGPTLoginLease(${JSON.stringify(account.id)}, process.pid, {
          homesDir: ${JSON.stringify(options.homesDir)}
        });
        process.stdout.write("claimed");
      } catch (error) {
        process.stdout.write(error.message);
      }
    `;
    const contender = spawnSync(process.execPath, ["--input-type=module", "-e", contenderSource], {
      cwd: path.resolve("."),
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(contender.status, 0, contender.stderr);
    assert.match(contender.stdout, /already in progress/i);
    await assert.rejects(
      removeChatGPTProfileAccount(account.id, options),
      /browser sign-in is in progress/i,
    );
  } finally {
    owner.kill("SIGKILL");
    await new Promise((resolve) => owner.once("close", resolve));
  }

  // The detached owner is gone, but a restarted GUI has no trustworthy exit
  // callback. An unexpired unknown owner remains fail-closed for direct CLI.
  await assert.rejects(
    removeChatGPTProfileAccount(account.id, options),
    /browser sign-in is in progress/i,
  );
  const removed = await removeChatGPTProfileAccount(account.id, {
    ...options,
    loginLeaseIdentity: () => undefined,
    now: Date.now() + CHATGPT_LOGIN_LEASE_MAX_AGE_MS + 1_000,
  });
  assert.equal(removed.removed.id, account.id);
});

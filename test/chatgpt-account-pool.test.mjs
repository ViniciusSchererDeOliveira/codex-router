import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  ACCOUNT_REFRESH_POLL_CONCURRENCY,
  ACCOUNT_REFRESH_POLL_LIMIT,
  ACCOUNT_REFRESH_RETRY_MS,
  claimChatGPTSubscriptionRefresh,
  chatGPTSubscriptionAccountAuthPath,
  chatGPTSubscriptionAccountHome,
  chatGPTSubscriptionAccountPoolSnapshot,
  chatGPTSubscriptionAccountStatus,
  createChatGPTSubscriptionAccount,
  readChatGPTAccountPoolState,
  refreshChatGPTSubscriptionAccount,
  refreshBoundedChatGPTSubscriptionAccounts,
  removeChatGPTSubscriptionAccount,
  sanitizeChatGPTAccountPool,
  withChatGPTAccountPoolLock,
  writeChatGPTAccountPoolState,
} from "../src/chatgpt-account-pool.mjs";
import {
  clearChatGPTLoginLease,
  createChatGPTLoginLease,
} from "../src/chatgpt-login-lease.mjs";

function runClaimChild(moduleUrl, account, options, now) {
  const source = `
    import { claimChatGPTSubscriptionRefresh } from ${JSON.stringify(moduleUrl)};
    const claimed = await claimChatGPTSubscriptionRefresh(${JSON.stringify(account)}, {
      filePath: ${JSON.stringify(options.filePath)}, now: ${now}
    });
    process.stdout.write(JSON.stringify(claimed));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve(JSON.parse(stdout))
      : reject(new Error(stderr || `claim child exited ${code}`)));
  });
}

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

test("an owned login lease keeps newly written OAuth auth pending and unusable", () => {
  const options = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  writeFileSync(chatGPTSubscriptionAccountAuthPath(account.id, options), JSON.stringify({
    tokens: { access_token: "access-token", account_id: "leased-account" },
  }), { mode: 0o600 });
  const identity = () => "test-process";
  const lease = createChatGPTLoginLease(account.id, process.pid, { ...options, identity });
  try {
    const snapshot = chatGPTSubscriptionAccountPoolSnapshot({
      ...options,
      loginLeaseIdentity: identity,
    });
    assert.equal(snapshot.accounts[account.id].subscription.status, "pending");
    assert.equal(snapshot.accounts[account.id].subscription.usable, false);
    assert.equal(snapshot.accounts[account.id].subscription.authenticated, false);
    assert.equal(snapshot.accounts[account.id].subscription.loginInProgress, true);
  } finally {
    assert.equal(clearChatGPTLoginLease(account.id, lease, options), true);
  }
});

test("sanitization keeps opaque router ids but never exposes account identity or credentials", () => {
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
  assert.equal(sanitized.accounts.acct_example_123456.id, "acct_example_123456");
  assert.equal("identity" in sanitized.accounts.acct_example_123456, false);
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

test("refresh attempt claims serialize across processes and preserve the retry window", async () => {
  const options = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  const moduleUrl = pathToFileURL(path.resolve("src/chatgpt-account-pool.mjs")).href;
  const now = Date.parse("2026-08-30T00:00:00.000Z");
  const claims = await Promise.all(Array.from({ length: 4 }, () => runClaimChild(
    moduleUrl,
    account.id,
    options,
    now,
  )));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await claimChatGPTSubscriptionRefresh(account.id, { filePath: options.filePath, now: now + 1 }), false);
  assert.equal(await claimChatGPTSubscriptionRefresh(account.id, {
    filePath: options.filePath,
    now: now + ACCOUNT_REFRESH_RETRY_MS + 1,
  }), true);
  const persisted = readFileSync(options.filePath, "utf8");
  assert.match(persisted, /lastRefreshAttemptAt/);
  assert.doesNotMatch(persisted, /access_token|refresh_token|id_token/);
});

test("automatic refresh keeps its exact lease until locked login finalization", async () => {
  const options = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  const lease = {
    version: 2,
    leaseId: "00000000-0000-4000-8000-000000000001",
    pid: 4321,
    processIdentity: "fixture-process",
    createdAt: Date.now(),
  };
  const calls = [];
  const refreshed = await refreshChatGPTSubscriptionAccount(account.id, {
    ...options,
    force: true,
    binary: process.execPath,
    execFileImpl: (_command, _args, _childOptions, callback) => {
      queueMicrotask(() => callback(null, "", ""));
      return { pid: lease.pid, kill() {} };
    },
    createLoginLease: () => {
      calls.push("lease-created");
      return lease;
    },
    attachLoginLease: (_id, expected) => {
      calls.push("lease-attached");
      return expected;
    },
    clearLoginLease: () => {
      calls.push("lease-cleared");
      return true;
    },
    finalizeLogin: async (id, finalizeOptions) => {
      calls.push("finalize-started");
      assert.equal(id, account.id);
      assert.equal(finalizeOptions.expectedLoginLease, lease);
      assert.equal(typeof finalizeOptions.clearLoginLease, "function");
      assert.equal(calls.includes("lease-cleared"), false);
    },
  });
  assert.equal(refreshed, true);
  assert.deepEqual(calls, ["lease-created", "lease-attached", "finalize-started"]);
});

test("automatic refresh finalizes digest evidence after a late nonzero exit", async () => {
  const options = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  const lease = {
    version: 3,
    leaseId: "00000000-0000-4000-8000-000000000002",
    pid: 4322,
    processIdentity: "fixture-process",
    createdAt: Date.now(),
    phase: "running",
    authDigestBefore: null,
  };
  const calls = [];
  const refreshed = await refreshChatGPTSubscriptionAccount(account.id, {
    ...options,
    force: true,
    binary: process.execPath,
    execFileImpl: (_command, _args, _childOptions, callback) => {
      queueMicrotask(() => callback(new Error("Codex exited after persisting auth"), "", ""));
      return { pid: lease.pid, kill() {} };
    },
    createLoginLease: () => {
      calls.push("lease-created");
      return { ...lease, phase: "reserved" };
    },
    attachLoginLease: () => {
      calls.push("lease-attached");
      return lease;
    },
    clearLoginLease: () => {
      calls.push("lease-cleared");
      return true;
    },
    finalizeLogin: async (_id, finalizeOptions) => {
      calls.push("finalize-started");
      assert.equal(finalizeOptions.expectedLoginLease, lease);
    },
  });
  assert.equal(refreshed, true);
  assert.deepEqual(calls, ["lease-created", "lease-attached", "finalize-started"]);
});

test("automatic refresh retains changed auth when process attachment fails", async () => {
  const options = fixture();
  const account = createChatGPTSubscriptionAccount(options);
  const lease = {
    version: 3,
    leaseId: "00000000-0000-4000-8000-000000000003",
    pid: process.pid,
    processIdentity: "fixture-parent",
    createdAt: Date.now(),
    phase: "reserved",
    authDigestBefore: null,
  };
  const calls = [];
  const refreshed = await refreshChatGPTSubscriptionAccount(account.id, {
    ...options,
    force: true,
    binary: process.execPath,
    execFileImpl: () => ({
      pid: 4323,
      kill() { calls.push("child-killed"); },
    }),
    createLoginLease: () => lease,
    attachLoginLease: () => {
      writeFileSync(
        chatGPTSubscriptionAccountAuthPath(account.id, { homesDir: options.homesDir }),
        JSON.stringify({ tokens: { access_token: "new-token", account_id: "new-account" } }),
        { mode: 0o600 },
      );
      throw new Error("process identity probe failed after auth write");
    },
    clearLoginLease: () => {
      calls.push("lease-cleared");
      return true;
    },
  });
  assert.equal(refreshed, false);
  assert.deepEqual(calls, ["child-killed"]);
});

test("one status poll bounds near-expiry refresh children and prioritizes the selected account", async () => {
  const selectedId = "acct_00000063";
  const accounts = Object.fromEntries(Array.from({ length: 64 }, (_, index) => {
    const id = `acct_${String(index).padStart(8, "0")}`;
    return [id, { id, subscription: { usable: true } }];
  }));
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  await refreshBoundedChatGPTSubscriptionAccounts({
    policy: { selectedAccountId: selectedId },
    accounts,
  }, {
    refresh: async (id) => {
      calls.push(id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    },
  });
  assert.equal(calls.length, ACCOUNT_REFRESH_POLL_LIMIT);
  assert.equal(calls[0], selectedId);
  assert.equal(maximumActive, ACCOUNT_REFRESH_POLL_CONCURRENCY);
});

test("account removal refuses symlinked roots and targets without deleting external data", () => {
  for (const targetKind of ["root", "account"]) {
    const options = fixture();
    const account = createChatGPTSubscriptionAccount(options);
    const originalPool = readFileSync(options.filePath, "utf8");
    const external = mkdtempSync(path.join(os.tmpdir(), `codex-account-external-${targetKind}-`));
    const sentinel = path.join(external, "keep.txt");
    writeFileSync(sentinel, "external-data", { mode: 0o600 });
    if (targetKind === "root") {
      renameSync(options.homesDir, `${options.homesDir}.owned`);
      symlinkSync(external, options.homesDir, process.platform === "win32" ? "junction" : "dir");
    } else {
      const home = chatGPTSubscriptionAccountHome(account.id, options);
      renameSync(home, `${home}.owned`);
      symlinkSync(external, home, process.platform === "win32" ? "junction" : "dir");
    }
    assert.throws(
      () => removeChatGPTSubscriptionAccount(account.id, options),
      /private directory|owned directory|lease/i,
    );
    assert.equal(readFileSync(sentinel, "utf8"), "external-data");
    assert.equal(readFileSync(options.filePath, "utf8"), originalPool);
    assert.equal(readChatGPTAccountPoolState(options.filePath).accounts[account.id].id, account.id);
    assert.equal(existsSync(sentinel), true);
  }
});

test("account removal refuses a symlinked ancestor without deleting external data", () => {
  const options = fixture();
  options.homesDir = path.join(options.root, "profile-parent", "accounts");
  const account = createChatGPTSubscriptionAccount(options);
  const originalPool = readFileSync(options.filePath, "utf8");
  const parent = path.dirname(options.homesDir);
  const external = mkdtempSync(path.join(os.tmpdir(), "codex-account-external-ancestor-"));
  const externalHome = path.join(external, "accounts", account.id);
  mkdirSync(externalHome, { recursive: true });
  const sentinel = path.join(externalHome, "keep.txt");
  writeFileSync(sentinel, "external-data", { mode: 0o600 });
  renameSync(parent, `${parent}.owned`);
  symlinkSync(external, parent, process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => removeChatGPTSubscriptionAccount(account.id, options),
    /symbolic-link|private directory|owned directory|lease/i,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "external-data");
  assert.equal(readFileSync(options.filePath, "utf8"), originalPool);
  assert.equal(readChatGPTAccountPoolState(options.filePath).accounts[account.id].id, account.id);
});

test("an existing malformed account list fails closed and is never replaced as first-run state", () => {
  const options = fixture();
  const damaged = '{"version":1,"policy":';
  writeFileSync(options.filePath, damaged, { mode: 0o600 });
  assert.throws(() => readChatGPTAccountPoolState(options.filePath), /could not be read as JSON/i);
  assert.throws(() => createChatGPTSubscriptionAccount(options), /could not be read as JSON/i);
  assert.equal(readFileSync(options.filePath, "utf8"), damaged);
});

test("an unreadable account-list path fails closed instead of becoming an empty pool", () => {
  const options = fixture();
  mkdirSync(options.filePath);
  assert.throws(() => readChatGPTAccountPoolState(options.filePath), /not a regular file/i);
  assert.throws(() => createChatGPTSubscriptionAccount(options), /not a regular file/i);
});

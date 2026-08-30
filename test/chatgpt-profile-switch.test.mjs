import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  chatGPTSubscriptionAccountAuthPath,
  chatGPTSubscriptionAccountCatalogDir,
  createChatGPTSubscriptionAccount,
  readChatGPTAccountPoolState,
  writeChatGPTAccountPoolState,
} from "../src/chatgpt-account-pool.mjs";
import {
  codexDesktopRunning,
  chatGPTProfileSwitchSnapshot,
  readChatGPTProfileSwitchState,
  reconcileChatGPTProfileSwitch,
  removeChatGPTProfileAccount,
  requestChatGPTProfileSwitch,
  selectChatGPTProfileAccount,
} from "../src/chatgpt-profile-switch.mjs";

function runModuleChild(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child exited ${code ?? signal}: ${stderr.trim()}`));
    });
  });
}

test("a selected profile waits for Codex to close and preserves both account profiles", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-switch-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });

  const pending = await requestChatGPTProfileSwitch(second.id, {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    refreshCatalog: false,
  });
  assert.equal(pending.pending, true);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);

  const applied = await reconcileChatGPTProfileSwitch({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  });
  assert.equal(applied.active, second.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  assert.equal(readFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), "utf8"), firstAuth);

  const restore = await requestChatGPTProfileSwitch(first.id, {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  });
  assert.equal(restore.active, first.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readChatGPTProfileSwitchState(switchPath).pending, false);
  assert.equal(chatGPTProfileSwitchSnapshot({ switchPath, platform: "darwin", processList: "" }).running, false);

  await requestChatGPTProfileSwitch(second.id, {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  });
  const autoPending = await requestChatGPTProfileSwitch("auto", {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    refreshCatalog: false,
  });
  assert.equal(autoPending.pending, false);
  assert.equal(autoPending.active, second.id);
  const autoApplied = await reconcileChatGPTProfileSwitch({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  });
  assert.equal(autoApplied.desired, second.id);
  assert.equal(autoApplied.active, second.id);
});

test("a saved account identity is bound before a later switch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-identity-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const options = { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "/Applications/Codex.app/Contents/MacOS/Codex", refreshCatalog: false };
  await requestChatGPTProfileSwitch(second.id, options);
  writeFileSync(
    chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }),
    JSON.stringify({ tokens: { access_token: "replacement-token", account_id: "replacement" } }),
    { mode: 0o600 },
  );
  await assert.rejects(
    requestChatGPTProfileSwitch(second.id, { ...options, processList: "" }),
    /does not match its login profile/i,
  );
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
});

test("malformed switch state retains durable rollback evidence and fails closed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-corrupt-state-"));
  const switchPath = path.join(root, "switch.json");
  const transactionDirectory = path.join(root, "chatgpt-profile", "switch-transaction");
  const evidencePath = path.join(transactionDirectory, "primary-auth.json");
  mkdirSync(transactionDirectory, { recursive: true });
  writeFileSync(evidencePath, '{"tokens":{"account_id":"rollback-account"}}', { mode: 0o600 });
  writeFileSync(switchPath, '{"version":1,"phase":', { mode: 0o600 });

  await assert.rejects(
    requestChatGPTProfileSwitch("auto", { switchPath }),
    /could not be read as JSON/i,
  );
  assert.equal(existsSync(evidencePath), true);
  assert.equal(readFileSync(evidencePath, "utf8"), '{"tokens":{"account_id":"rollback-account"}}');

  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    pending: true,
    phase: "future-phase",
  }), { mode: 0o600 });
  await assert.rejects(
    requestChatGPTProfileSwitch("auto", { switchPath }),
    /phase is invalid/i,
  );
  assert.equal(existsSync(evidencePath), true);
});

test("profile detection fails closed across desktop process names", () => {
  assert.equal(codexDesktopRunning({ platform: "darwin", processList: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" }), true);
  assert.equal(codexDesktopRunning({ platform: "darwin", processList: "/usr/bin/codex app-server" }), false);
  assert.equal(codexDesktopRunning({ platform: "win32", processList: '"Codex.exe","123","Console","1","42 K"' }), true);
  assert.equal(codexDesktopRunning({ platform: "win32", processList: '"codex-cli.exe","123","Console","1","42 K"' }), false);
  assert.equal(codexDesktopRunning({ platform: "linux", processList: "/opt/Codex-desktop --profile default" }), true);
  assert.equal(codexDesktopRunning({ platform: "linux", processList: "/usr/local/bin/codex app-server" }), true);
  assert.equal(codexDesktopRunning({ platform: "linux", processList: "/usr/local/bin/codex-router" }), false);
  assert.equal(codexDesktopRunning({ platform: "plan9", processList: "" }), true);
  assert.equal(codexDesktopRunning({ platform: "linux", processListReader: () => { throw new Error("ps unavailable"); } }), true);
});

test("profile switching rejects symlinked login files before mutating the active profile", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-symlink-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = path.join(root, "second-auth.json");
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(secondAuth, JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } }), { mode: 0o600 });
  symlinkSync(secondAuth, chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }));
  await assert.rejects(
    requestChatGPTProfileSwitch(second.id, { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", refreshCatalog: false }),
    /unavailable|symbolic-link/i,
  );
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readChatGPTProfileSwitchState(switchPath).active, first.id);
});

test("a catalog refresh failure restores the previous auth and catalog atomically", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-rollback-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const modelsCachePath = path.join(root, "models_cache.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  writeFileSync(modelsCachePath, '{"account":"first"}', { mode: 0o600 });
  const firstCatalog = path.join(chatGPTSubscriptionAccountCatalogDir(first.id, { homesDir }), "models_cache.json");
  mkdirSync(path.dirname(firstCatalog), { recursive: true });
  writeFileSync(firstCatalog, '{"account":"first"}', { mode: 0o600 });
  const secondCatalog = path.join(chatGPTSubscriptionAccountCatalogDir(second.id, { homesDir }), "models_cache.json");
  mkdirSync(path.dirname(secondCatalog), { recursive: true });
  writeFileSync(secondCatalog, '{"account":"second"}', { mode: 0o600 });
  await assert.rejects(
    requestChatGPTProfileSwitch(second.id, {
      filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", modelsCachePath,
      refreshCatalog: () => { throw new Error("simulated catalog crash"); },
    }),
    /simulated catalog crash/,
  );
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readFileSync(modelsCachePath, "utf8"), '{"account":"first"}');
  assert.equal(readChatGPTProfileSwitchState(switchPath).active, first.id);
  assert.equal(readChatGPTProfileSwitchState(switchPath).pending, true);
});

test("concurrent account switches serialize without producing a torn auth file", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-concurrent-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const options = { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", refreshCatalog: false };
  await Promise.all([requestChatGPTProfileSwitch(second.id, options), requestChatGPTProfileSwitch(first.id, options)]);
  const active = readFileSync(path.join(primaryHome, "auth.json"), "utf8");
  assert.ok(active === firstAuth || active === secondAuth);
  assert.equal(readChatGPTProfileSwitchState(switchPath).pending, false);
});

test("switching accounts restores each native catalog without losing routed models", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-catalog-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const catalog = Object.fromEntries([
    ["modelsCachePath", path.join(root, "models_cache.json")],
    ["nativeCatalogPath", path.join(root, "native-models.json")],
    ["mergedCatalogPath", path.join(root, "merged-models.json")],
    ["nativeAliasPath", path.join(root, "native-aliases.json")],
    ["announcedModelsPath", path.join(root, "announced-models.json")],
  ]);
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });

  const firstFiles = {
    modelsCachePath: JSON.stringify({ account: "first", models: ["gpt-free"] }),
    nativeCatalogPath: JSON.stringify({ account: "first", models: [{ slug: "gpt-free", visibility: "list" }] }),
    mergedCatalogPath: JSON.stringify({ account: "first", models: ["gpt-free", "opencode-go/deepseek-v4-flash"] }),
  };
  for (const [key, contents] of Object.entries(firstFiles)) writeFileSync(catalog[key], contents, { mode: 0o600 });
  const secondDir = chatGPTSubscriptionAccountCatalogDir(second.id, { homesDir });
  mkdirSync(secondDir, { recursive: true, mode: 0o700 });
  const secondFiles = {
    "models_cache.json": JSON.stringify({ account: "second", models: ["gpt-plus"] }),
    "native-models.json": JSON.stringify({ account: "second", models: [{ slug: "gpt-plus", visibility: "list" }] }),
    "merged-models.json": JSON.stringify({ account: "second", models: ["gpt-plus", "opencode-go/deepseek-v4-flash"] }),
  };
  for (const [name, contents] of Object.entries(secondFiles)) writeFileSync(path.join(secondDir, name), contents, { mode: 0o600 });

  const options = {
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
    ...catalog,
  };
  const applied = await requestChatGPTProfileSwitch(second.id, options);
  assert.equal(applied.active, second.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  assert.equal(readFileSync(catalog.modelsCachePath, "utf8"), secondFiles["models_cache.json"]);
  assert.equal(readFileSync(catalog.nativeCatalogPath, "utf8"), secondFiles["native-models.json"]);
  assert.equal(readFileSync(catalog.mergedCatalogPath, "utf8"), secondFiles["merged-models.json"]);

  await requestChatGPTProfileSwitch(first.id, options);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
  assert.equal(readFileSync(catalog.modelsCachePath, "utf8"), firstFiles.modelsCachePath);
  assert.equal(readFileSync(catalog.nativeCatalogPath, "utf8"), firstFiles.nativeCatalogPath);
  assert.equal(readFileSync(catalog.mergedCatalogPath, "utf8"), firstFiles.mergedCatalogPath);
  assert.equal(readFileSync(path.join(secondDir, "native-models.json"), "utf8"), secondFiles["native-models.json"]);
});

test("an interrupted switch rolls back durable auth and catalog before retrying", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-crash-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const modelsCachePath = path.join(root, "models_cache.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  writeFileSync(modelsCachePath, JSON.stringify({ account: "first" }), { mode: 0o600 });
  const firstCatalog = chatGPTSubscriptionAccountCatalogDir(first.id, { homesDir });
  const secondCatalog = chatGPTSubscriptionAccountCatalogDir(second.id, { homesDir });
  mkdirSync(firstCatalog, { recursive: true, mode: 0o700 });
  mkdirSync(secondCatalog, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(firstCatalog, "models_cache.json"), JSON.stringify({ account: "first" }), { mode: 0o600 });
  writeFileSync(path.join(secondCatalog, "models_cache.json"), JSON.stringify({ account: "second" }), { mode: 0o600 });

  const modulePath = path.resolve("src/chatgpt-profile-switch.mjs");
  const childSource = `
    import { requestChatGPTProfileSwitch } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    await requestChatGPTProfileSwitch(${JSON.stringify(second.id)}, {
      filePath: ${JSON.stringify(filePath)}, homesDir: ${JSON.stringify(homesDir)},
      primaryHome: ${JSON.stringify(primaryHome)}, switchPath: ${JSON.stringify(switchPath)},
      platform: "darwin", processList: "", modelsCachePath: ${JSON.stringify(modelsCachePath)},
      staleMs: 2000, waitMs: 5000,
      refreshCatalog: () => process.kill(process.pid, "SIGKILL"),
    });
  `;
 const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", childSource], {
   cwd: path.resolve("."),
   encoding: "utf8",
 });
  if (process.platform === "win32") {
    assert.ok(crashed.status !== 0 || crashed.signal !== null);
  } else {
    assert.equal(crashed.signal, "SIGKILL");
  }
 const interrupted = readChatGPTProfileSwitchState(switchPath);
  assert.equal(interrupted.phase, "backed-up");
  assert.equal(interrupted.pending, true);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  assert.equal(JSON.parse(readFileSync(modelsCachePath, "utf8")).account, "second");

  const applied = await reconcileChatGPTProfileSwitch({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    modelsCachePath,
    staleMs: 2000,
    waitMs: 5000,
    refreshCatalog: () => {},
  });
  assert.equal(applied.active, second.id);
  assert.equal(applied.pending, false);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  assert.equal(JSON.parse(readFileSync(modelsCachePath, "utf8")).account, "second");
});

test("reconcile completes an installed transaction after restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-installed-recovery-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  const transactionDir = path.join(root, "chatgpt-profile", "switch-transaction");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), secondAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(transactionDir, "primary-auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(path.join(transactionDir, "manifest.json"), JSON.stringify({
    version: 1,
    active: first.id,
    target: second.id,
    activeAccountId: "first",
    targetAccountId: "second",
    catalogsEnabled: false,
  }), { mode: 0o600 });
  writeFileSync(switchPath, JSON.stringify({
    version: 1,
    desired: second.id,
    active: second.id,
    pending: false,
    phase: "installed",
  }), { mode: 0o600 });

  const recovered = await reconcileChatGPTProfileSwitch({
    filePath,
    homesDir,
    primaryHome,
    switchPath,
    platform: "darwin",
    processList: "",
    refreshCatalog: false,
  });
  assert.equal(recovered.active, second.id);
  assert.equal(recovered.pending, false);
  assert.equal(recovered.phase, "idle");
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), secondAuth);
  assert.equal(existsSync(transactionDir), false);
});

test("cross-process account selections commit one matching policy and profile", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-policy-concurrent-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const modulePath = pathToFileURL(path.resolve("src/chatgpt-profile-switch.mjs")).href;
  const options = { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", refreshCatalog: false };
  const childSource = (selection) => `
    import { selectChatGPTProfileAccount } from ${JSON.stringify(modulePath)};
    await selectChatGPTProfileAccount(${JSON.stringify(selection)}, ${JSON.stringify(options)});
  `;
  await Promise.all([
    runModuleChild(childSource(second.id)),
    runModuleChild(childSource(first.id)),
  ]);
  const pool = readChatGPTAccountPoolState(filePath);
  const profile = readChatGPTProfileSwitchState(switchPath);
  assert.equal(profile.pending, false);
  assert.equal(pool.policy.selectedAccountId, profile.active);
  assert.equal(profile.desired, profile.active);
  const activeIdentity = JSON.parse(readFileSync(path.join(primaryHome, "auth.json"), "utf8")).tokens.account_id;
  assert.equal(activeIdentity, profile.active === first.id ? "first" : "second");
});

test("a policy commit failure rolls the native profile back to its prior account", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-policy-rollback-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const options = { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", refreshCatalog: false };
  await requestChatGPTProfileSwitch(first.id, options);
  const initialPool = readChatGPTAccountPoolState(filePath);
  initialPool.policy.selectedAccountId = first.id;
  writeChatGPTAccountPoolState(initialPool, filePath);
  await assert.rejects(
    selectChatGPTProfileAccount(second.id, {
      ...options,
      writeAccountPoolState: () => { throw new Error("simulated policy write failure"); },
    }),
    /simulated policy write failure/,
  );
  assert.equal(readChatGPTAccountPoolState(filePath).policy.selectedAccountId, first.id);
  assert.equal(readChatGPTProfileSwitchState(switchPath).active, first.id);
  assert.equal(readChatGPTProfileSwitchState(switchPath).desired, first.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
});

test("a removal failure rolls back the required active-profile handoff", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-profile-remove-rollback-"));
  const primaryHome = path.join(root, "primary");
  const homesDir = path.join(root, "accounts");
  const filePath = path.join(root, "pool.json");
  const switchPath = path.join(root, "switch.json");
  mkdirSync(primaryHome, { recursive: true });
  const first = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const second = createChatGPTSubscriptionAccount({ filePath, homesDir });
  const firstAuth = JSON.stringify({ tokens: { access_token: "first-token", account_id: "first" } });
  const secondAuth = JSON.stringify({ tokens: { access_token: "second-token", account_id: "second" } });
  writeFileSync(path.join(primaryHome, "auth.json"), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(first.id, { homesDir }), firstAuth, { mode: 0o600 });
  writeFileSync(chatGPTSubscriptionAccountAuthPath(second.id, { homesDir }), secondAuth, { mode: 0o600 });
  const options = { filePath, homesDir, primaryHome, switchPath, platform: "darwin", processList: "", refreshCatalog: false };
  await requestChatGPTProfileSwitch(first.id, options);
  const initialPool = readChatGPTAccountPoolState(filePath);
  initialPool.policy.selectedAccountId = first.id;
  writeChatGPTAccountPoolState(initialPool, filePath);
  await assert.rejects(
    removeChatGPTProfileAccount(first.id, {
      ...options,
      removeAccount: () => { throw new Error("simulated account removal failure"); },
    }),
    /simulated account removal failure/,
  );
  assert.ok(readChatGPTAccountPoolState(filePath).accounts[first.id]);
  assert.equal(readChatGPTAccountPoolState(filePath).policy.selectedAccountId, first.id);
  assert.equal(readChatGPTProfileSwitchState(switchPath).active, first.id);
  assert.equal(readFileSync(path.join(primaryHome, "auth.json"), "utf8"), firstAuth);
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  chatGPTSubscriptionAccountAuthPath,
  chatGPTSubscriptionAccountCatalogDir,
  createChatGPTSubscriptionAccount,
} from "../src/chatgpt-account-pool.mjs";
import {
  codexDesktopRunning,
  chatGPTProfileSwitchSnapshot,
  readChatGPTProfileSwitchState,
  reconcileChatGPTProfileSwitch,
  requestChatGPTProfileSwitch,
} from "../src/chatgpt-profile-switch.mjs";

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

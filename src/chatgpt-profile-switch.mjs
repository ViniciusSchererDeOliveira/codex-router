import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile, writePrivateJson } from "./file-security.mjs";
import { withCatalogPublicationLock } from "./catalog-publication-lock.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import {
  CHATGPT_ACCOUNT_HOMES_DIR,
  CHATGPT_ACCOUNT_POOL_PATH,
  CHATGPT_PROFILE_SWITCH_PATH,
  CODEX_HOME,
  MERGED_CATALOG_PATH,
  MODELS_CACHE_PATH,
  NATIVE_ALIAS_PATH,
  NATIVE_CATALOG_PATH,
  ANNOUNCED_MODELS_PATH,
} from "./paths.mjs";
import {
  chatGPTSubscriptionAccountCatalogDir,
  createChatGPTSubscriptionAccount,
  chatGPTSubscriptionAccountHome,
  chatGPTSubscriptionAccountAuthPath,
  chatGPTSubscriptionAccountStatus,
  isChatGPTAccountId,
  readChatGPTAccountPoolState,
  removeChatGPTSubscriptionAccount,
  sanitizeChatGPTAccountPool,
  writeChatGPTAccountPoolState,
  withChatGPTAccountPoolLock,
} from "./chatgpt-account-pool.mjs";

const VERSION = 1;
const LEGACY_PRIMARY = "primary";
const AUTO = "auto";
const CATALOG_ARTIFACTS = Object.freeze([
  ["models_cache.json", "modelsCachePath"],
  ["native-models.json", "nativeCatalogPath"],
  ["merged-models.json", "mergedCatalogPath"],
  ["native-aliases.json", "nativeAliasPath"],
  ["announced-models.json", "announcedModelsPath"],
]);

function assertProfileDiscoveryEnabled() {
  if (discoveryDisabled()) {
    throw new Error(
      "ChatGPT account profiles are unavailable while credential discovery is disabled.",
    );
  }
}

function catalogLockOptions(options = {}) {
  return {
    stateDir: options.catalogLockStateDir
      || path.dirname(options.switchPath || CHATGPT_PROFILE_SWITCH_PATH),
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
  };
}

function withProfileCatalogLock(operation, options = {}) {
  return withCatalogPublicationLock(operation, catalogLockOptions(options));
}

function transactionDirectory(switchPath = CHATGPT_PROFILE_SWITCH_PATH) {
  return path.join(path.dirname(switchPath), "chatgpt-profile", "switch-transaction");
}

function transactionManifestPath(switchPath) {
  return path.join(transactionDirectory(switchPath), "manifest.json");
}

function transactionAuthPath(switchPath) {
  return path.join(transactionDirectory(switchPath), "primary-auth.json");
}

function catalogPaths(options = {}) {
  return {
    modelsCachePath: options.modelsCachePath || MODELS_CACHE_PATH,
    nativeCatalogPath: options.nativeCatalogPath || NATIVE_CATALOG_PATH,
    mergedCatalogPath: options.mergedCatalogPath || MERGED_CATALOG_PATH,
    nativeAliasPath: options.nativeAliasPath || NATIVE_ALIAS_PATH,
    announcedModelsPath: options.announcedModelsPath || ANNOUNCED_MODELS_PATH,
  };
}

function catalogHandlingEnabled(options = {}) {
  return options.refreshCatalog !== false || CATALOG_ARTIFACTS.some(([, key]) => options[key]);
}

function atomicContents(target, contents) {
  const parent = path.dirname(target);
  ensureNoSymlinkParents(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  ensureNoSymlinkParents(parent);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    ensureNoSymlinkParents(parent);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new Error("Refusing to replace a symbolic-link catalog artifact.");
    }
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function ensureNoSymlinkParents(target) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const relative = path.relative(root, absolute);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (!isAllowedSystemTempLink(current)) {
        throw new Error(`Refusing to traverse a symbolic-link path: ${current}`);
      }
      continue;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Profile path component is not a directory: ${current}`);
    }
  }
}

function isAllowedSystemTempLink(target) {
  const normalized = path.resolve(target);
  if (!["/var", "/tmp"].includes(normalized)) return false;
  try {
    const resolved = path.resolve(realpathSync(normalized));
    return normalized === "/var"
      ? resolved === "/private/var"
      : resolved === "/private/tmp";
  } catch {
    return false;
  }
}

function accountCatalogPath(accountId, artifact, options = {}) {
  return path.join(
    chatGPTSubscriptionAccountCatalogDir(accountId, { homesDir: options.homesDir }),
    artifact,
  );
}

function copyOptionalArtifact(source, destination) {
  if (!existsSync(source)) return false;
  ensureNoSymlinkParents(path.dirname(source));
  const file = lstatSync(source);
  if (file.isSymbolicLink()) throw new Error(`Catalog artifact is a symbolic link: ${source}`);
  if (!file.isFile()) throw new Error(`Catalog artifact is not a regular file: ${source}`);
  atomicPrivateCopy(source, destination);
  return true;
}

function removeOptionalArtifact(target) {
  ensureNoSymlinkParents(path.dirname(target));
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`Refusing to remove a symbolic-link catalog artifact: ${target}`);
  }
  rmSync(target, { force: true });
}

function snapshotAccountCatalog(accountId, options = {}) {
  const paths = catalogPaths(options);
  for (const [artifact, key] of CATALOG_ARTIFACTS) {
    copyOptionalArtifact(paths[key], accountCatalogPath(accountId, artifact, options));
  }
}

function restoreAccountCatalog(accountId, options = {}) {
  const paths = catalogPaths(options);
  for (const [artifact, key] of CATALOG_ARTIFACTS) {
    const source = accountCatalogPath(accountId, artifact, options);
    if (existsSync(source)) copyOptionalArtifact(source, paths[key]);
    else if (artifact === "models_cache.json" || artifact === "native-models.json") {
      removeOptionalArtifact(paths[key]);
    }
  }
}

function snapshotGlobalCatalog(options = {}) {
  const paths = catalogPaths(options);
  return Object.fromEntries(
    CATALOG_ARTIFACTS.map(([artifact, key]) => [
      key,
      existsSync(paths[key])
        ? (() => {
            ensureNoSymlinkParents(path.dirname(paths[key]));
            const file = lstatSync(paths[key]);
            if (file.isSymbolicLink() || !file.isFile()) {
              throw new Error(`Catalog artifact is not a regular file: ${paths[key]}`);
            }
            return readFileSync(paths[key], "utf8");
          })()
        : undefined,
    ]),
  );
}

function restoreGlobalCatalog(snapshot, options = {}) {
  const paths = catalogPaths(options);
  for (const [, key] of CATALOG_ARTIFACTS) {
    const contents = snapshot[key];
    if (contents === undefined) removeOptionalArtifact(paths[key]);
    else atomicContents(paths[key], contents);
  }
}

function writeSwitchTransaction({
  switchPath,
  active,
  target,
  targetIdentity,
  primary,
  catalogsEnabled,
  globalCatalogSnapshot,
}) {
  const directory = transactionDirectory(switchPath);
  ensureNoSymlinkParents(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  ensureNoSymlinkParents(directory);
  const identity = authIdentity(primary);
  if (!identity) throw new Error("The active ChatGPT login profile has no verified identity.");
  atomicPrivateCopy(primary, transactionAuthPath(switchPath));
  writePrivateJson(transactionManifestPath(switchPath), {
    version: VERSION,
    active,
    target,
    activeAccountId: identity.accountId,
    targetAccountId: targetIdentity.accountId,
    catalogsEnabled: catalogsEnabled === true,
    ...(catalogsEnabled ? { globalCatalogSnapshot } : {}),
  }, { directoryMode: 0o700 });
  return {
    active,
    target,
    activeAccountId: identity.accountId,
    targetAccountId: targetIdentity.accountId,
    catalogsEnabled: catalogsEnabled === true,
    globalCatalogSnapshot,
  };
}

function readSwitchTransaction(switchPath) {
  const directory = transactionDirectory(switchPath);
  if (!existsSync(directory)) return undefined;
  ensureNoSymlinkParents(directory);
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("The ChatGPT profile switch transaction is not a private directory.");
  }
  const manifestPath = transactionManifestPath(switchPath);
  const authPath = transactionAuthPath(switchPath);
  if (!existsSync(manifestPath) || !existsSync(authPath)) {
    throw new Error("The ChatGPT profile switch transaction is incomplete.");
  }
  const manifestStat = lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error("The ChatGPT profile switch transaction manifest is invalid.");
  }
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    parsed?.version !== VERSION
    || !isChatGPTAccountId(parsed.active)
    || !isChatGPTAccountId(parsed.target)
    || typeof parsed.activeAccountId !== "string"
    || !parsed.activeAccountId.trim()
    || typeof parsed.targetAccountId !== "string"
    || !parsed.targetAccountId.trim()
  ) {
    throw new Error("The ChatGPT profile switch transaction manifest is invalid.");
  }
  ensureAuthFile(authPath, "The saved");
  if (authIdentity(authPath)?.accountId !== parsed.activeAccountId) {
    throw new Error("The ChatGPT profile switch transaction identity does not match its manifest.");
  }
  return {
    active: parsed.active,
    target: parsed.target,
    activeAccountId: parsed.activeAccountId,
    targetAccountId: parsed.targetAccountId,
    catalogsEnabled: parsed.catalogsEnabled === true,
    globalCatalogSnapshot: parsed.catalogsEnabled === true && parsed.globalCatalogSnapshot
      ? parsed.globalCatalogSnapshot
      : undefined,
  };
}

function removeSwitchTransaction(switchPath) {
  const directory = transactionDirectory(switchPath);
  if (!existsSync(directory)) return;
  ensureNoSymlinkParents(directory);
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("The ChatGPT profile switch transaction is not a private directory.");
  }
  rmSync(directory, { recursive: true, force: true });
}

function restoreSwitchTransaction(transaction, switchPath, options) {
  atomicPrivateCopy(transactionAuthPath(switchPath), primaryAuthPath(options.primaryHome));
  if (transaction.catalogsEnabled) {
    restoreGlobalCatalog(transaction.globalCatalogSnapshot || {}, options);
  }
}

async function refreshActiveCatalog(options = {}) {
  if (options.refreshCatalog === false) return;
  if (typeof options.refreshCatalog === "function") {
    await options.refreshCatalog();
    return;
  }
  // The profile transaction already owns the catalog publication lock. Calling
  // catalog.mjs as a child would try to acquire that same cross-process lock
  // and deadlock; invoke its exported publication body inside this lease.
  const { publishCatalog } = await import("./catalog.mjs");
  publishCatalog({ refreshNative: true, output: false });
}

function normalizeSelection(value) {
  const selection = String(value || "").trim();
  if (selection === LEGACY_PRIMARY || selection === AUTO || isChatGPTAccountId(selection)) return selection;
  throw new Error("Account selection must be automatic or a registered account id.");
}

function defaultState() {
  return { version: VERSION, desired: undefined, active: undefined, pending: false, phase: "idle" };
}

export function readChatGPTProfileSwitchState(filePath = CHATGPT_PROFILE_SWITCH_PATH) {
  assertProfileDiscoveryEnabled();
  let file;
  try {
    file = lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return defaultState();
    throw new Error("The saved ChatGPT profile switch state could not be inspected.", { cause: error });
  }
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error("The saved ChatGPT profile switch state is not a regular file.");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error("The saved ChatGPT profile switch state could not be read as JSON.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== VERSION) {
    throw new Error("The saved ChatGPT profile switch state has an unsupported schema.");
  }
  if (
    parsed.desired !== undefined
    && parsed.desired !== AUTO
    && parsed.desired !== LEGACY_PRIMARY
    && !isChatGPTAccountId(parsed.desired)
  ) throw new Error("The saved ChatGPT profile switch target is invalid.");
  if (
    parsed.active !== undefined
    && parsed.active !== LEGACY_PRIMARY
    && !isChatGPTAccountId(parsed.active)
  ) throw new Error("The saved active ChatGPT profile is invalid.");
  if (typeof parsed.pending !== "boolean") {
    throw new Error("The saved ChatGPT profile pending state is invalid.");
  }
  if (!["idle", "preparing", "backed-up", "installed"].includes(parsed.phase)) {
    throw new Error("The saved ChatGPT profile switch phase is invalid.");
  }
  return {
    version: VERSION,
    desired: parsed.desired,
    active: parsed.active,
    pending: parsed.pending,
    phase: parsed.phase,
  };
}

function writeState(state, filePath) {
  const value = {
    version: VERSION,
    ...(state.desired ? { desired: state.desired } : {}),
    ...(state.active ? { active: state.active } : {}),
    pending: state.pending === true,
    phase: state.phase || "idle",
  };
  writePrivateJson(filePath, value, { directoryMode: 0o700 });
  return value;
}

function primaryAuthPath(primaryHome = CODEX_HOME) {
  return path.join(primaryHome, "auth.json");
}

function backupAuthPath(filePath = CHATGPT_PROFILE_SWITCH_PATH) {
  return path.join(path.dirname(filePath), "chatgpt-profile", "primary-auth.json");
}

function profileAuthPath(selection, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {}) {
  return chatGPTSubscriptionAccountAuthPath(selection, { homesDir });
}

function ensureAuthFile(filePath, label) {
  try {
    ensureNoSymlinkParents(path.dirname(filePath));
    const file = lstatSync(filePath);
    if (file.isSymbolicLink() || !file.isFile()) throw new Error();
    return filePath;
  } catch {
    throw new Error(`${label} login profile is unavailable.`);
  }
}

export function atomicPrivateCopy(source, destination, { protect = protectPrivateFile } = {}) {
  ensureAuthFile(source, "The selected");
  ensureNoSymlinkParents(path.dirname(destination));
  if (existsSync(destination)) {
    const target = lstatSync(destination);
    if (target.isSymbolicLink()) throw new Error("Refusing to replace a symbolic-link login profile.");
  }
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  ensureNoSymlinkParents(path.dirname(destination));
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    copyFileSync(source, temporary, fsConstants.COPYFILE_EXCL);
    protect(temporary);
    ensureNoSymlinkParents(path.dirname(destination));
    if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
      throw new Error("Refusing to replace a symbolic-link login profile.");
    }
    renameSync(temporary, destination);
    // rename preserves the temporary file's DACL on Windows, but protect the
    // final path as well so every OAuth credential replacement is verified at
    // the name Codex will open. POSIX remains an owner-only chmod.
    protect(destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function syncAuthProfile(source, destination) {
  ensureAuthFile(source, "The active");
  ensureAuthFile(destination, "The saved");
  const sourceMtime = statSync(source).mtimeMs;
  const destinationMtime = statSync(destination).mtimeMs;
  if (sourceMtime >= destinationMtime) atomicPrivateCopy(source, destination);
  else atomicPrivateCopy(destination, source);
}

function authIdentity(filePath) {
  if (!existsSync(filePath)) return undefined;
  try {
    ensureNoSymlinkParents(path.dirname(filePath));
    const file = lstatSync(filePath);
    if (file.isSymbolicLink() || !file.isFile() || (process.platform !== "win32" && (file.mode & 0o077) !== 0)) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const tokens = parsed?.tokens;
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id.trim() : "";
    if (!accountId) return undefined;
    let email;
    try {
      const payload = JSON.parse(Buffer.from(String(tokens?.id_token || "").split(".")[1] || "", "base64url").toString("utf8"));
      email = typeof payload?.email === "string" ? payload.email.trim() : undefined;
    } catch {
      email = undefined;
    }
    return { accountId, ...(email ? { email } : {}) };
  } catch {
    return undefined;
  }
}

function accountForAuth(state, authPath, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {}) {
  const identity = authIdentity(authPath);
  if (!identity) return undefined;
  const matches = [];
  for (const id of Object.keys(state.accounts)) {
    const bound = state.accounts[id]?.identity?.accountId;
    if (bound && bound === identity.accountId) {
      matches.push(id);
      continue;
    }
    const candidate = authIdentity(chatGPTSubscriptionAccountAuthPath(id, { homesDir }));
    if (candidate?.accountId === identity.accountId) matches.push(id);
  }
  if (matches.length > 1) throw new Error("The ChatGPT account identity is registered more than once.");
  return matches[0];
}

function ensureProfileAccountLocked({
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  primaryHome = CODEX_HOME,
  switchPath = CHATGPT_PROFILE_SWITCH_PATH,
} = {}) {
  let state = readChatGPTAccountPoolState(filePath);
  const sources = [
    primaryAuthPath(primaryHome),
    backupAuthPath(switchPath),
  ];
  let currentAccountId;
  for (const source of sources) {
    const identity = authIdentity(source);
    if (!identity) continue;
    let id = accountForAuth(state, source, { homesDir });
    if (!id) {
      const created = createChatGPTSubscriptionAccount({ filePath, homesDir, label: "" });
      id = created.id;
      atomicPrivateCopy(source, chatGPTSubscriptionAccountAuthPath(id, { homesDir }));
      state = readChatGPTAccountPoolState(filePath);
    }
    const account = state.accounts[id];
    if (account?.identity?.accountId && account.identity.accountId !== identity.accountId) {
      throw new Error("The saved ChatGPT account identity does not match its login profile.");
    }
    if (account) {
      const nextIdentity = {
        accountId: identity.accountId,
        ...(identity.email ? { email: identity.email } : {}),
      };
      if (
        account.identity?.accountId !== nextIdentity.accountId
        || account.identity?.email !== nextIdentity.email
      ) {
        account.identity = nextIdentity;
        writeChatGPTAccountPoolState(state, filePath);
        state = readChatGPTAccountPoolState(filePath);
      }
    }
    if (source === primaryAuthPath(primaryHome)) currentAccountId = id;
  }
  let identitiesChanged = false;
  const seenIdentities = new Map();
  for (const [id, account] of Object.entries(state.accounts)) {
    const identity = authIdentity(chatGPTSubscriptionAccountAuthPath(id, { homesDir }));
    if (!identity) continue;
    const bound = account?.identity?.accountId;
    if (bound && bound !== identity.accountId) {
      throw new Error("The saved ChatGPT account identity does not match its login profile.");
    }
    const duplicate = seenIdentities.get(identity.accountId);
    if (duplicate && duplicate !== id) {
      throw new Error("The ChatGPT account identity is registered more than once.");
    }
    seenIdentities.set(identity.accountId, id);
    if (!bound) {
      account.identity = { accountId: identity.accountId, ...(identity.email ? { email: identity.email } : {}) };
      identitiesChanged = true;
    }
  }
  if (identitiesChanged) {
    writeChatGPTAccountPoolState(state, filePath);
    state = readChatGPTAccountPoolState(filePath);
  }
  if (currentAccountId) {
    const profile = readChatGPTProfileSwitchState(switchPath);
    const desired = profile.desired === LEGACY_PRIMARY ? currentAccountId : profile.desired;
    const pending = Boolean(desired && desired !== currentAccountId && profile.pending);
    if (profile.active !== currentAccountId || profile.desired === LEGACY_PRIMARY) {
      writeState({ ...profile, active: currentAccountId, desired, pending }, switchPath);
    }
  }
  return {
    state,
    currentAccountId,
  };
}

export async function ensureChatGPTProfileAccounts(options = {}) {
  assertProfileDiscoveryEnabled();
  return withChatGPTAccountPoolLock(
    () => ensureProfileAccountLocked(options),
    { filePath: options.filePath || CHATGPT_ACCOUNT_POOL_PATH },
  );
}

export function codexDesktopRunning({ platform = process.platform, processList, processListReader } = {}) {
  if (!["darwin", "win32", "linux", "freebsd"].includes(platform)) return true;
  let listing = processList;
  if (listing === undefined) {
    try {
      listing = typeof processListReader === "function"
        ? processListReader(platform)
        : platform === "win32"
          ? execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
          : execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return true;
    }
  }
  const patterns = platform === "darwin"
    ? [/\/((?:ChatGPT|Codex)\.app)\/Contents\/MacOS\/(?:ChatGPT|Codex)(?:\s|$)/]
    : platform === "win32"
      ? [/(?:^|[\\/\s",])(?:ChatGPT|Codex)\.exe(?:[\s",]|$)/i]
      : [/(?:^|[\\/])(?:ChatGPT|Codex)(?:[- ]desktop)?(?:\.AppImage)?(?:\s|$)/i];
  return String(listing).split(/\r?\n/).some((line) => patterns.some((pattern) => pattern.test(line)));
}

function validateSelection(selection, { filePath = CHATGPT_ACCOUNT_POOL_PATH, currentAccountId } = {}) {
  const normalized = normalizeSelection(selection);
  if (normalized === LEGACY_PRIMARY) return currentAccountId;
  if (normalized === AUTO) return normalized;
  const state = readChatGPTAccountPoolState(filePath);
  const account = state.accounts[normalized];
  if (!account || account.state !== "active" || account.paused) {
    throw new Error("The selected subscription account is not active.");
  }
  return normalized;
}

function restorePreviousProfile(active, { homesDir, primaryHome }) {
  const primary = primaryAuthPath(primaryHome);
  const current = profileAuthPath(active, { homesDir });
  if (existsSync(current)) atomicPrivateCopy(current, primary);
}

function recoverInterruptedSwitchLocked(options) {
  const switchPath = options.switchPath || CHATGPT_PROFILE_SWITCH_PATH;
  const state = readChatGPTProfileSwitchState(switchPath);
  const transaction = readSwitchTransaction(switchPath);
  if (!transaction) {
    if (state.phase !== "idle") {
      throw new Error(`The ChatGPT profile switch has no durable transaction for phase ${state.phase}.`);
    }
    return state;
  }
  if (state.phase === "idle") {
    const completed = !state.pending
      && state.active === transaction.target
      && state.desired === transaction.target;
    const rolledBack = state.pending
      && state.active === transaction.active
      && state.desired === transaction.target;
    if (!completed && !rolledBack) {
      throw new Error("The idle ChatGPT profile state does not match its durable transaction.");
    }
    removeSwitchTransaction(switchPath);
    return state;
  }
  if (state.phase === "installed") {
    const targetProfile = profileAuthPath(transaction.target, {
      homesDir: options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR,
    });
    const targetIdentity = authIdentity(targetProfile);
    const primaryIdentity = authIdentity(primaryAuthPath(options.primaryHome));
    if (
      !targetIdentity
      || targetIdentity.accountId !== transaction.targetAccountId
      || !primaryIdentity
      || primaryIdentity.accountId !== transaction.targetAccountId
    ) {
      restoreSwitchTransaction(transaction, switchPath, options);
      const rolledBack = writeState({
        ...state,
        desired: transaction.target,
        active: transaction.active,
        pending: true,
        phase: "idle",
      }, switchPath);
      removeSwitchTransaction(switchPath);
      return rolledBack;
    }
    const completed = writeState({
      desired: transaction.target,
      active: transaction.target,
      pending: false,
      phase: "idle",
    }, switchPath);
    removeSwitchTransaction(switchPath);
    return completed;
  }
  restoreSwitchTransaction(transaction, switchPath, options);
  const recovered = writeState({
    ...state,
    desired: transaction.target,
    active: transaction.active,
    pending: true,
    phase: "idle",
  }, switchPath);
  removeSwitchTransaction(switchPath);
  return recovered;
}

async function applyLocked(selection, options) {
  const {
    filePath = CHATGPT_ACCOUNT_POOL_PATH,
    homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
    primaryHome = CODEX_HOME,
    switchPath = CHATGPT_PROFILE_SWITCH_PATH,
  } = options;
  const migration = ensureProfileAccountLocked({ filePath, homesDir, primaryHome, switchPath });
  const current = readChatGPTProfileSwitchState(switchPath);
  const active = current.active || migration.currentAccountId;
  const targetSelection = selection === LEGACY_PRIMARY ? migration.currentAccountId : selection;
  if (!active && targetSelection !== AUTO) throw new Error("No logged-in ChatGPT account is available.");
  if (codexDesktopRunning(options)) {
    const target = targetSelection === AUTO ? active : targetSelection;
    return writeState({ ...current, desired: target, active, pending: Boolean(target && target !== active), phase: "idle" }, switchPath);
  }
  const target = targetSelection === AUTO ? active : targetSelection;
  if (target === active) {
    return writeState({ ...current, desired: target, active, pending: false, phase: "idle" }, switchPath);
  }
  const primary = primaryAuthPath(primaryHome);
  const activeProfile = profileAuthPath(active, { homesDir });
  const targetProfile = profileAuthPath(target, { homesDir });
  ensureAuthFile(activeProfile, "The active");
  ensureAuthFile(targetProfile, "The selected");
  const poolState = readChatGPTAccountPoolState(filePath);
  const targetIdentity = authIdentity(targetProfile);
  const boundIdentity = poolState.accounts[target]?.identity?.accountId;
  if (!targetIdentity) throw new Error("The selected ChatGPT login profile has no verified identity.");
  if (boundIdentity && boundIdentity !== targetIdentity.accountId) {
    throw new Error("The selected ChatGPT login profile identity does not match its saved account.");
  }
  const catalogsEnabled = catalogHandlingEnabled(options);
  const globalCatalogSnapshot = catalogsEnabled ? snapshotGlobalCatalog(options) : undefined;
  if (catalogsEnabled) snapshotAccountCatalog(active, options);
  let transaction;
  try {
    transaction = writeSwitchTransaction({
      switchPath,
      active,
      target,
      targetIdentity,
      primary,
      catalogsEnabled,
      globalCatalogSnapshot,
    });
    writeState({ ...current, desired: target, active, pending: true, phase: "preparing" }, switchPath);
    syncAuthProfile(primary, activeProfile);
    writeState({ ...current, desired: target, active, pending: true, phase: "backed-up" }, switchPath);
    atomicPrivateCopy(targetProfile, primary);
    if (catalogsEnabled) {
      restoreAccountCatalog(target, options);
      await refreshActiveCatalog(options);
      snapshotAccountCatalog(target, options);
    }
    writeState({ desired: target, active: target, pending: false, phase: "installed" }, switchPath);
    const completed = writeState({ desired: target, active: target, pending: false, phase: "idle" }, switchPath);
    removeSwitchTransaction(switchPath);
    return completed;
  } catch (error) {
    try {
      if (transaction) restoreSwitchTransaction(transaction, switchPath, options);
      else {
        restorePreviousProfile(active, { homesDir, primaryHome });
        if (catalogsEnabled) restoreGlobalCatalog(globalCatalogSnapshot, options);
      }
      writeState({ ...current, desired: target, active, pending: true, phase: "idle" }, switchPath);
      removeSwitchTransaction(switchPath);
    } catch {
      writeState({ ...current, desired: target, active, pending: true, phase: "backed-up" }, switchPath);
    }
    throw error;
  }
}

export async function requestChatGPTProfileSwitch(selection, options = {}) {
  assertProfileDiscoveryEnabled();
  return withChatGPTAccountPoolLock(
    () => withProfileCatalogLock(
      () => applyRequestedSelectionLocked(selection, options),
      options,
    ),
    accountPoolLockOptions(options),
  );
}

function accountPoolLockOptions(options) {
  return {
    filePath: options.filePath || CHATGPT_ACCOUNT_POOL_PATH,
    ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
  };
}

async function applyRequestedSelectionLocked(selection, options) {
  recoverInterruptedSwitchLocked(options);
  const migration = ensureProfileAccountLocked(options);
  const normalized = validateSelection(selection, {
    ...options,
    currentAccountId: migration.currentAccountId,
  });
  return applyLocked(normalized, options);
}

async function restoreAccountTransaction({ pool, profile }, options) {
  const filePath = options.filePath || CHATGPT_ACCOUNT_POOL_PATH;
  const switchPath = options.switchPath || CHATGPT_PROFILE_SWITCH_PATH;
  const current = readChatGPTProfileSwitchState(switchPath);
  if (current.phase !== "idle") {
    throw new Error(`The ChatGPT profile rollback requires recovery from phase ${current.phase}.`);
  }
  if (profile.active && current.active !== profile.active) {
    await applyLocked(profile.active, options);
  }
  writeState(profile, switchPath);
  writeChatGPTAccountPoolState(pool, filePath);
}

/**
 * Select an account and update the native profile under the same cross-process
 * lock. A desktop-open selection is intentionally represented as
 * policy.selectedAccountId === profile.desired with profile.pending === true.
 */
export async function selectChatGPTProfileAccount(selection, options = {}) {
  assertProfileDiscoveryEnabled();
  return withChatGPTAccountPoolLock(() => withProfileCatalogLock(async () => {
    recoverInterruptedSwitchLocked(options);
    const migration = ensureProfileAccountLocked(options);
    const normalized = validateSelection(selection, {
      ...options,
      currentAccountId: migration.currentAccountId,
    });
    if (normalized === AUTO || normalized === LEGACY_PRIMARY) {
      throw new Error("Select a registered ChatGPT account id.");
    }
    const filePath = options.filePath || CHATGPT_ACCOUNT_POOL_PATH;
    const switchPath = options.switchPath || CHATGPT_PROFILE_SWITCH_PATH;
    const before = {
      pool: readChatGPTAccountPoolState(filePath),
      profile: readChatGPTProfileSwitchState(switchPath),
    };
    try {
      const profile = await applyLocked(normalized, options);
      const current = readChatGPTAccountPoolState(filePath);
      const account = current.accounts[normalized];
      if (!account || account.state !== "active" || account.paused) {
        throw new Error("The selected subscription account changed while the profile was switching.");
      }
      const selectedProfile = profile.desired || profile.active;
      if (selectedProfile !== normalized || (profile.pending && profile.active === normalized)) {
        throw new Error("The native profile selection did not reach a consistent state.");
      }
      current.policy.enabled = true;
      current.policy.selectedAccountId = normalized;
      const writePool = options.writeAccountPoolState || writeChatGPTAccountPoolState;
      const pool = writePool(current, filePath);
      return { pool: sanitizeChatGPTAccountPool(pool), profile };
    } catch (error) {
      try {
        await restoreAccountTransaction(before, options);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "ChatGPT account selection and rollback both failed.");
      }
      throw error;
    }
  }, options), accountPoolLockOptions(options));
}

/** Remove an account, including any required profile handoff, under one lock. */
export async function removeChatGPTProfileAccount(accountId, options = {}) {
  assertProfileDiscoveryEnabled();
  if (!isChatGPTAccountId(accountId)) throw new Error("Account id is invalid.");
  return withChatGPTAccountPoolLock(() => withProfileCatalogLock(async () => {
    recoverInterruptedSwitchLocked(options);
    ensureProfileAccountLocked(options);
    const filePath = options.filePath || CHATGPT_ACCOUNT_POOL_PATH;
    const switchPath = options.switchPath || CHATGPT_PROFILE_SWITCH_PATH;
    const before = {
      pool: readChatGPTAccountPoolState(filePath),
      profile: readChatGPTProfileSwitchState(switchPath),
    };
    const account = before.pool.accounts[accountId];
    if (!account) throw new Error("Account id is not registered.");
    if (before.profile.pending && before.profile.desired === accountId) {
      throw new Error("Cannot remove a ChatGPT account with a pending native profile selection.");
    }
    try {
      let profile = before.profile;
      if (profile.active === accountId) {
        if (codexDesktopRunning(options)) {
          throw new Error("Close Codex before removing the active subscription account.");
        }
        const replacement = Object.values(before.pool.accounts).find(
          (candidate) => candidate.id !== accountId
            && candidate.state === "active"
            && !candidate.paused,
        );
        if (!replacement) throw new Error("Cannot remove the only logged-in ChatGPT account.");
        profile = await applyLocked(replacement.id, options);
        if (profile.active !== replacement.id || profile.pending) {
          throw new Error("The replacement ChatGPT profile did not become active.");
        }
      }
      const current = readChatGPTAccountPoolState(filePath);
      if (!current.accounts[accountId]) {
        throw new Error("The ChatGPT account changed while it was being removed.");
      }
      const selected = profile.desired || profile.active;
      const removeAccount = options.removeAccount || removeChatGPTSubscriptionAccount;
      const removed = removeAccount(accountId, {
        filePath,
        homesDir: options.homesDir || CHATGPT_ACCOUNT_HOMES_DIR,
        ...(selected && selected !== accountId ? { selectedAccountId: selected } : {}),
      });
      return {
        removed,
        pool: sanitizeChatGPTAccountPool(readChatGPTAccountPoolState(filePath)),
        profile,
      };
    } catch (error) {
      try {
        await restoreAccountTransaction(before, options);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "ChatGPT account removal and rollback both failed.");
      }
      throw error;
    }
  }, options), accountPoolLockOptions(options));
}

export async function reconcileChatGPTProfileSwitch(options = {}) {
  assertProfileDiscoveryEnabled();
  return withChatGPTAccountPoolLock(
    () => withProfileCatalogLock(async () => {
      // Desired is a mutable policy decision. Read it only after both locks
      // are held; a reconciler that remembers B while a newer selector commits
      // A can otherwise install the stale login after it finally acquires them.
      recoverInterruptedSwitchLocked(options);
      const state = readChatGPTProfileSwitchState(
        options.switchPath || CHATGPT_PROFILE_SWITCH_PATH,
      );
      if (!state.pending && state.phase === "idle") return state;
      return applyRequestedSelectionLocked(state.desired, options);
    }, options),
    accountPoolLockOptions(options),
  );
}

export async function reconcileChatGPTProfileSwitchIfReady(options = {}) {
  assertProfileDiscoveryEnabled();
  const state = chatGPTProfileSwitchSnapshot(options);
  // This is the safe polling/startup hook: it performs no mutation for settled
  // idle state, and never mutates while Codex is running. Once Codex releases
  // auth, it completes either an earlier explicit pending selection or durable
  // crash recovery from a non-idle transaction phase under both locks.
  if (state.running || (!state.pending && state.phase === "idle")) return state;
  return reconcileChatGPTProfileSwitch(options);
}

export function selectedChatGPTUsageProfile({
  filePath = CHATGPT_ACCOUNT_POOL_PATH,
  homesDir = CHATGPT_ACCOUNT_HOMES_DIR,
  primaryHome = CODEX_HOME,
  switchPath = CHATGPT_PROFILE_SWITCH_PATH,
} = {}) {
  assertProfileDiscoveryEnabled();
  const pool = readChatGPTAccountPoolState(filePath);
  const profile = readChatGPTProfileSwitchState(switchPath);
  const selection = pool.policy.selectedAccountId || profile.active;
  if (!selection || selection === AUTO || selection === LEGACY_PRIMARY) return { selection: selection || AUTO, home: undefined, pending: profile.pending };
  const account = pool.accounts[selection];
  if (!account || account.state !== "active") return { selection, home: undefined, pending: profile.pending };
  return {
    selection,
    home: path.dirname(chatGPTSubscriptionAccountAuthPath(selection, { homesDir })),
    email: chatGPTSubscriptionAccountStatus(selection, { homesDir }).email,
    pending: profile.pending && profile.desired === selection,
  };
}

export function chatGPTProfileSwitchSnapshot(options = {}) {
  assertProfileDiscoveryEnabled();
  const state = readChatGPTProfileSwitchState(options.switchPath || CHATGPT_PROFILE_SWITCH_PATH);
  return { ...state, running: codexDesktopRunning(options) };
}

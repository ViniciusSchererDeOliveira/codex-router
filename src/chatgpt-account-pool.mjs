import { execFile } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

import lockfile from "proper-lockfile";

import { writePrivateJson } from "./file-security.mjs";
import { CHATGPT_ACCOUNT_HOMES_DIR, CHATGPT_ACCOUNT_POOL_PATH } from "./paths.mjs";
import { findCodexBinary } from "./codex-binary.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

export const CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION = 1;

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{8,80}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ACCOUNTS = 64;
const MAX_ERROR_LENGTH = 512;
const EXPIRY_SKEW_MS = 120_000;
const ACCOUNT_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_REFRESH_RETRY_MS = 5 * 60 * 1000;
const refreshAttempts = new Map();

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}
function iso(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function isoNow(now = Date.now()) { return new Date(Number.isFinite(now) ? now : Date.now()).toISOString(); }
function accountId(value) {
  const id = text(value);
  if (!ACCOUNT_ID.test(id)) throw new Error("accountId must be an opaque acct_ identifier.");
  return id;
}
export function isChatGPTAccountId(value) { return typeof value === "string" && ACCOUNT_ID.test(value.trim()); }

function normalizePolicy(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const selected = text(source.selectedAccountId);
  return { enabled: source.enabled !== false, mode: "switch", ...(ACCOUNT_ID.test(selected) ? { selectedAccountId: selected } : {}) };
}
function normalizeIdentity(raw) {
  const value = text(raw?.accountId);
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return { accountId: value, ...(text(raw.email) ? { email: text(raw.email).slice(0, 320) } : {}) };
}
function normalizeHealth(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const state = ["healthy", "cooldown", "reauth-required", "failed"].includes(source.state) ? source.state : "healthy";
  return {
    state,
    ...(iso(source.cooldownUntil) ? { cooldownUntil: iso(source.cooldownUntil) } : {}),
    ...(iso(source.lastSuccessAt) ? { lastSuccessAt: iso(source.lastSuccessAt) } : {}),
    ...(iso(source.lastErrorAt) ? { lastErrorAt: iso(source.lastErrorAt) } : {}),
    ...(iso(source.lastUsedAt) ? { lastUsedAt: iso(source.lastUsedAt) } : {}),
    ...(number(source.lastStatus) !== undefined ? { lastStatus: integer(source.lastStatus, 500, { min: 100, max: 999 }) } : {}),
    ...(text(source.lastError) ? { lastError: text(source.lastError).slice(0, MAX_ERROR_LENGTH) } : {}),
  };
}
function normalizeSubscription(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const status = ["pending", "usable", "expired", "invalid"].includes(raw.status) ? raw.status : "pending";
  return {
    status,
    ...(typeof raw.authenticated === "boolean" ? { authenticated: raw.authenticated } : {}),
    ...(typeof raw.usable === "boolean" ? { usable: raw.usable } : {}),
    ...(typeof raw.expired === "boolean" ? { expired: raw.expired } : {}),
    ...(typeof raw.hasAccountId === "boolean" ? { hasAccountId: raw.hasAccountId } : {}),
    ...(number(raw.expiresInHours) !== undefined ? { expiresInHours: number(raw.expiresInHours) } : {}),
    ...(text(raw.email) ? { email: text(raw.email).slice(0, 320) } : {}),
    ...(raw.usage && typeof raw.usage === "object" ? { usage: { ...raw.usage } } : {}),
  };
}
function normalizeAccount(raw, id) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const state = ["active", "paused", "revoked"].includes(raw.state) ? raw.state : "active";
  const identity = normalizeIdentity(raw.identity);
  const subscription = normalizeSubscription(raw.subscription);
  return {
    id,
    state,
    paused: raw.paused === true,
    priority: integer(raw.priority, 50, { min: 0, max: 100_000 }),
    ...(text(raw.label) ? { label: text(raw.label).slice(0, 120) } : {}),
    ...(iso(raw.createdAt) ? { createdAt: iso(raw.createdAt) } : {}),
    ...(identity ? { identity } : {}),
    ...(subscription ? { subscription } : {}),
    health: normalizeHealth(raw.health),
    turns: integer(raw.turns, 0),
    requests: integer(raw.requests, 0),
  };
}
function emptyState() { return { version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION, policy: normalizePolicy(), accounts: {}, sessions: {} }; }
function normalizeState(raw) {
  const result = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  result.policy = normalizePolicy(raw.policy);
  for (const [id, value] of Object.entries(raw.accounts || {}).slice(0, MAX_ACCOUNTS)) {
    if (!ACCOUNT_ID.test(id)) continue;
    const account = normalizeAccount(value, id);
    if (account) result.accounts[id] = account;
  }
  return result;
}
export function readChatGPTAccountPoolState(filePath = CHATGPT_ACCOUNT_POOL_PATH) {
  if (!existsSync(filePath)) return emptyState();
  try { return normalizeState(JSON.parse(readFileSync(filePath, "utf8"))); } catch { return emptyState(); }
}
export function writeChatGPTAccountPoolState(state, filePath = CHATGPT_ACCOUNT_POOL_PATH) {
  const normalized = normalizeState({ ...state, version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION });
  writePrivateJson(filePath, normalized, { directoryMode: 0o700 });
  return normalized;
}

function newAccountId(state) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = `acct_${randomBytes(12).toString("base64url")}`;
    if (!state.accounts[id]) return id;
  }
  throw new Error("Could not allocate a unique ChatGPT account id.");
}
function nextAccountLabel(state) {
  const used = new Set(Object.values(state.accounts).filter((account) => account?.state !== "revoked").map((account) => {
    const match = /^ChatGPT account (\d+)$/.exec(account?.label || "");
    return match ? Number(match[1]) : undefined;
  }).filter(Number.isInteger));
  let numberValue = 1;
  while (used.has(numberValue)) numberValue += 1;
  return `ChatGPT account ${numberValue}`;
}
export function createChatGPTSubscriptionAccount({ label = "", filePath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  const state = readChatGPTAccountPoolState(filePath);
  if (Object.values(state.accounts).filter((account) => account?.state !== "revoked").length >= MAX_ACCOUNTS) throw new Error(`The ChatGPT account list supports at most ${MAX_ACCOUNTS} accounts.`);
  const id = newAccountId(state);
  const home = chatGPTSubscriptionAccountHome(id, { homesDir });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const account = normalizeAccount({ id, state: "active", label: text(label).slice(0, 120) || nextAccountLabel(state), createdAt: isoNow(now), subscription: { status: "pending" }, health: { state: "healthy" } }, id);
  state.accounts[id] = account;
  try { writeChatGPTAccountPoolState(state, filePath); } catch (error) { rmSync(home, { recursive: true, force: true }); throw error; }
  return sanitizeChatGPTAccount(account);
}
export function chatGPTSubscriptionAccountHome(accountValue, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {}) { return path.join(homesDir, accountId(accountValue)); }
export function chatGPTSubscriptionAccountAuthPath(accountValue, options = {}) { return path.join(chatGPTSubscriptionAccountHome(accountValue, options), "auth.json"); }
export function chatGPTSubscriptionAccountCatalogDir(accountValue, options = {}) { return path.join(chatGPTSubscriptionAccountHome(accountValue, options), "router-catalog"); }
export function removeChatGPTSubscriptionAccount(accountValue, { filePath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR } = {}) {
  const id = accountId(accountValue);
  const state = readChatGPTAccountPoolState(filePath);
  const removed = state.accounts[id];
  if (!removed) throw new Error("Account id is not registered.");
  delete state.accounts[id];
  if (state.policy.selectedAccountId === id) delete state.policy.selectedAccountId;
  writeChatGPTAccountPoolState(state, filePath);
  rmSync(chatGPTSubscriptionAccountHome(id, { homesDir }), { recursive: true, force: true });
  return sanitizeChatGPTAccount({ ...removed, state: "revoked", paused: true });
}

function tokenExpiryMs(accessToken) {
  try {
    const payload = String(accessToken).split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(claims?.exp) ? claims.exp * 1000 : undefined;
  } catch { return undefined; }
}
function tokenEmail(idToken) {
  try {
    const payload = String(idToken || "").split(".")[1];
    if (!payload) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const email = typeof claims?.email === "string" ? claims.email.trim() : "";
    return email.length <= 320 && EMAIL.test(email) ? email : undefined;
  } catch { return undefined; }
}
function readSubscriptionSession(accountValue, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  const authPath = chatGPTSubscriptionAccountAuthPath(accountValue, { homesDir });
  if (!existsSync(authPath)) return undefined;
  try {
    const file = lstatSync(authPath);
    if (file.isSymbolicLink() || !file.isFile()) return undefined;
    if (process.platform !== "win32" && (file.mode & 0o077) !== 0) return undefined;
    const parsed = JSON.parse(readFileSync(authPath, "utf8"));
    const tokens = parsed?.tokens;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : "";
    if (!accessToken || accessToken.length > 64 * 1024 || /[\u0000-\u001f\u007f]/.test(accessToken)) return undefined;
    const accountIdValue = typeof tokens?.account_id === "string" ? tokens.account_id : "";
    const expiresAtMs = tokenExpiryMs(accessToken);
    const expired = expiresAtMs !== undefined && expiresAtMs - EXPIRY_SKEW_MS <= now;
    const email = tokenEmail(tokens?.id_token);
    return { accessToken, accountId: accountIdValue, expiresAtMs, expired, ...(email ? { email } : {}) };
  } catch { return undefined; }
}
export function chatGPTSubscriptionAccountStatus(accountValue, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  const session = readSubscriptionSession(accountValue, { homesDir, now });
  return {
    authenticated: Boolean(session), usable: Boolean(session) && !session.expired, expired: Boolean(session?.expired), hasAccountId: Boolean(session?.accountId),
    ...(session?.email ? { email: session.email } : {}),
    expiresInHours: session?.expiresAtMs === undefined ? undefined : Math.round(((session.expiresAtMs - now) / 36e5) * 10) / 10,
  };
}
export function refreshChatGPTSubscriptionAccount(accountValue, { homesDir = CHATGPT_ACCOUNT_HOMES_DIR, force = false, now = Date.now(), binary, execFileImpl = execFile } = {}) {
  const id = accountId(accountValue);
  const status = chatGPTSubscriptionAccountStatus(id, { homesDir, now });
  const expiresSoon = status.expiresInHours !== undefined && status.expiresInHours * 36e5 <= ACCOUNT_REFRESH_MARGIN_MS;
  if (!force && !status.expired && !expiresSoon) return Promise.resolve(false);
  const attemptedAt = refreshAttempts.get(id) || 0;
  if (!force && now - attemptedAt < ACCOUNT_REFRESH_RETRY_MS) return Promise.resolve(false);
  const resolvedBinary = binary || findCodexBinary();
  if (!resolvedBinary) return Promise.resolve(false);
  const target = spawnableCommand(resolvedBinary, ["login", "status"]);
  refreshAttempts.set(id, now);
  return new Promise((resolve) => execFileImpl(target.command, target.args, { ...target.options, env: { ...process.env, CODEX_HOME: chatGPTSubscriptionAccountHome(id, { homesDir }) }, encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true }, (error) => resolve(!error)));
}
export function chatGPTSubscriptionAccountPoolSnapshot({ filePath = CHATGPT_ACCOUNT_POOL_PATH, homesDir = CHATGPT_ACCOUNT_HOMES_DIR, now = Date.now() } = {}) {
  const state = readChatGPTAccountPoolState(filePath);
  const sanitized = sanitizeChatGPTAccountPool(state);
  for (const [id, account] of Object.entries(sanitized.accounts)) {
    const status = chatGPTSubscriptionAccountStatus(id, { homesDir, now });
    account.subscription = { ...(account.subscription || {}), status: status.usable ? "usable" : status.expired ? "expired" : status.authenticated ? "invalid" : "pending", ...status };
  }
  return sanitized;
}
export function sanitizeChatGPTAccount(account) {
  if (!account) return null;
  return {
    id: account.id, state: account.state, paused: account.paused === true, priority: account.priority,
    ...(account.label ? { label: account.label } : {}), ...(account.createdAt ? { createdAt: account.createdAt } : {}),
    ...(account.identity ? { identity: { ...account.identity } } : {}), ...(account.subscription ? { subscription: { ...account.subscription } } : {}),
    health: { ...account.health, ...(account.health?.lastError ? { lastError: "[redacted]" } : {}) }, turns: account.turns, requests: account.requests,
  };
}
export function sanitizeChatGPTAccountPool(state) {
  const normalized = normalizeState(state);
  return {
    version: CHATGPT_ACCOUNT_POOL_SCHEMA_VERSION, policy: { ...normalized.policy },
    accounts: Object.fromEntries(Object.entries(normalized.accounts).map(([id, account]) => [id, sanitizeChatGPTAccount(account)])), sessions: {},
  };
}
export async function withChatGPTAccountPoolLock(operation, { filePath = CHATGPT_ACCOUNT_POOL_PATH, waitMs = 120_000, retryMs = 25, staleMs = 10 * 60_000 } = {}) {
  const lockTarget = `${filePath}.pool-lock`;
  const lockPath = `${lockTarget}.lock`;
  const retries = Math.max(0, Math.ceil(waitMs / retryMs) - 1);
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let release;
  try {
    release = await lockfile.lock(lockTarget, { realpath: false, lockfilePath: lockPath, stale: Math.max(2_000, staleMs), retries: { retries, factor: 1, minTimeout: retryMs, maxTimeout: retryMs, randomize: false } });
    return await operation();
  } finally { if (release) await release().catch(() => {}); }
}

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { ensureNoSymlinkParents } from "./path-security.mjs";
import { processStartIdentity } from "./process-identity.mjs";

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{8,80}$/;
const LEASE_VERSION = 1;
export const CHATGPT_LOGIN_LEASE_MAX_AGE_MS = 15 * 60_000;

function accountId(value) {
  const id = String(value || "").trim();
  if (!ACCOUNT_ID.test(id)) throw new Error("Account id is invalid.");
  return id;
}

function verifiedAccountHome(value, {
  homesDir,
  accountHome,
} = {}) {
  const id = accountId(value);
  if (!homesDir && !accountHome) throw new Error("The ChatGPT login lease home is unavailable.");
  const home = path.resolve(accountHome || path.join(homesDir, id));
  const root = path.resolve(homesDir || path.dirname(home));
  if (path.basename(home) !== id || path.dirname(home) !== root) {
    throw new Error("The ChatGPT login lease escaped its account home.");
  }
  ensureNoSymlinkParents(root, { label: "ChatGPT login lease root" });
  ensureNoSymlinkParents(home, { label: "ChatGPT login lease account home" });
  for (const [target, label] of [[root, "root"], [home, "account home"]]) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`The ChatGPT login lease ${label} is not a private directory.`);
    }
  }
  const realRoot = realpathSync(root);
  if (path.dirname(realpathSync(home)) !== realRoot) {
    throw new Error("The ChatGPT login lease account home is not owned by its root.");
  }
  // Revalidate directly before the caller reads, creates, or clears its lease.
  ensureNoSymlinkParents(home, { label: "ChatGPT login lease account home" });
  if (realpathSync(root) !== realRoot || path.dirname(realpathSync(home)) !== realRoot) {
    throw new Error("The ChatGPT login lease account home changed during validation.");
  }
  return home;
}

export function chatGPTLoginLeasePath(value, options = {}) {
  return path.join(verifiedAccountHome(value, options), "router-login-lease.json");
}

function readLease(value, options = {}) {
  const leasePath = chatGPTLoginLeasePath(value, options);
  if (!existsSync(leasePath)) return { leasePath, lease: undefined };
  const stat = lstatSync(leasePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("The ChatGPT browser-login lease is invalid.");
  }
  let lease;
  try {
    lease = JSON.parse(readFileSync(leasePath, "utf8"));
  } catch (error) {
    throw new Error("The ChatGPT browser-login lease could not be read.", { cause: error });
  }
  if (
    !lease
    || typeof lease !== "object"
    || Array.isArray(lease)
    || lease.version !== LEASE_VERSION
    || !Number.isSafeInteger(lease.pid)
    || lease.pid < 1
    || typeof lease.processIdentity !== "string"
    || !lease.processIdentity
    || !Number.isFinite(lease.createdAt)
  ) {
    throw new Error("The ChatGPT browser-login lease is invalid.");
  }
  return { leasePath, lease };
}

export function createChatGPTLoginLease(value, pid, {
  identity = processStartIdentity,
  now = Date.now(),
  ...options
} = {}) {
  const processIdentity = identity(pid);
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof processIdentity !== "string" || !processIdentity) {
    throw new Error("Codex login started, but its process ownership could not be verified.");
  }
  const leasePath = chatGPTLoginLeasePath(value, options);
  const lease = { version: LEASE_VERSION, pid, processIdentity, createdAt: now };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor;
    let created = false;
    try {
      descriptor = openSync(
        leasePath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      created = true;
      writeFileSync(descriptor, `${JSON.stringify(lease)}\n`, "utf8");
      closeSync(descriptor);
      descriptor = undefined;
      protectPrivateFile(leasePath);
      return lease;
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      if (created) {
        // A failed write or owner-only protection must not leave a claim that
        // this caller reports as failed. Match the record before removal so a
        // replacement owner is never deleted by cleanup from this attempt.
        try { clearChatGPTLoginLease(value, lease, options); } catch {}
      }
      if (error?.code !== "EEXIST") throw error;
      const status = chatGPTLoginLeaseStatus(value, { identity, now, ...options });
      if (status.active) {
        throw new Error("A browser sign-in is already in progress for this ChatGPT account.");
      }
    }
  }
  throw new Error("The ChatGPT browser-login lease changed while it was being claimed.");
}

export function clearChatGPTLoginLease(value, expected, options = {}) {
  const { leasePath, lease } = readLease(value, options);
  if (!lease) return false;
  if (
    expected
    && (lease.pid !== expected.pid || lease.processIdentity !== expected.processIdentity)
  ) return false;
  unlinkSync(leasePath);
  return true;
}

export function chatGPTLoginLeaseStatus(value, {
  identity = processStartIdentity,
  now = Date.now(),
  maxAgeMs = CHATGPT_LOGIN_LEASE_MAX_AGE_MS,
  ...options
} = {}) {
  const { leasePath, lease } = readLease(value, options);
  if (!lease) return { active: false, stale: false };
  const currentIdentity = identity(lease.pid);
  if (currentIdentity === lease.processIdentity) {
    return { active: true, stale: false, pid: lease.pid };
  }
  const expired = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && now - lease.createdAt > maxAgeMs;
  if ((typeof currentIdentity === "string" && currentIdentity) || expired) {
    if (clearChatGPTLoginLease(value, lease, options)) {
      return { active: false, stale: true };
    }
    // Another creator replaced the stale record between validation and
    // cleanup. Never report the new, uninspected owner as inactive.
    return { active: true, stale: false, uncertain: true };
  }
  // An unavailable process probe is not proof of exit. Keep the bounded lease
  // fail closed until its deadline so a transient Windows/ps failure cannot
  // let removal race a still-running detached OAuth callback.
  return { active: true, stale: false, pid: lease.pid, uncertain: true };
}

export function assertChatGPTLoginLeaseInactive(value, options = {}) {
  if (chatGPTLoginLeaseStatus(value, options).active) {
    throw new Error("Cannot remove a ChatGPT account while its browser sign-in is in progress.");
  }
}

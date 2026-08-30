import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { ensureNoSymlinkParents } from "./path-security.mjs";
import { processStartIdentity } from "./process-identity.mjs";

const ACCOUNT_ID = /^acct_[A-Za-z0-9_-]{8,80}$/;
const LEASE_VERSION = 2;
const LEGACY_LEASE_VERSION = 1;
const LEASE_FILE = "router-login-lease.json";
const RELOCATED_LEASE = /^router-login-lease\.relocated-[0-9a-f-]{36}\.json$/i;
const LEASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LEASE_RECORDS = 32;
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
  return path.join(verifiedAccountHome(value, options), LEASE_FILE);
}

function validateLease(lease) {
  const versionValid = lease?.version === LEGACY_LEASE_VERSION
    || (lease?.version === LEASE_VERSION && typeof lease.leaseId === "string" && LEASE_ID.test(lease.leaseId));
  if (
    !lease
    || typeof lease !== "object"
    || Array.isArray(lease)
    || !versionValid
    || !Number.isSafeInteger(lease.pid)
    || lease.pid < 1
    || typeof lease.processIdentity !== "string"
    || !lease.processIdentity
    || !Number.isFinite(lease.createdAt)
  ) {
    throw new Error("The ChatGPT browser-login lease is invalid.");
  }
  return lease;
}

function readLeaseAt(leasePath) {
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
  return validateLease(lease);
}

function leaseRecords(value, options = {}) {
  const home = verifiedAccountHome(value, options);
  const names = readdirSync(home)
    .filter((name) => name === LEASE_FILE || RELOCATED_LEASE.test(name))
    .sort((left, right) => left === LEASE_FILE ? -1 : right === LEASE_FILE ? 1 : left.localeCompare(right));
  if (names.length > MAX_LEASE_RECORDS) {
    throw new Error("Too many ChatGPT browser-login lease records were found.");
  }
  const records = [];
  for (const name of names) {
    const leasePath = path.join(home, name);
    try {
      records.push({ leasePath, fixed: name === LEASE_FILE, lease: readLeaseAt(leasePath) });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return records;
}

function sameLease(left, right) {
  return Boolean(
    left
    && right
    && left.version === right.version
    && left.pid === right.pid
    && left.processIdentity === right.processIdentity
    && left.createdAt === right.createdAt
    && left.leaseId === right.leaseId,
  );
}

function relocatedLeasePath(leasePath) {
  const home = path.dirname(leasePath);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = path.join(home, `router-login-lease.relocated-${randomUUID()}.json`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Could not allocate a ChatGPT browser-login lease relocation.");
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
  const lease = { version: LEASE_VERSION, leaseId: randomUUID(), pid, processIdentity, createdAt: now };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const status = chatGPTLoginLeaseStatus(value, { identity, now, ...options });
    if (status.active) {
      throw new Error("A browser sign-in is already in progress for this ChatGPT account.");
    }
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
      // A prior owner's cleanup can relocate this generation while it is
      // being claimed. Relocated records remain authoritative, but any other
      // generation means this claimant lost exclusivity and must withdraw.
      if (leaseRecords(value, options).some(({ lease: candidate }) => !sameLease(candidate, lease))) {
        clearChatGPTLoginLease(value, lease, options);
        throw new Error("A browser sign-in is already in progress for this ChatGPT account.");
      }
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
    }
  }
  throw new Error("The ChatGPT browser-login lease changed while it was being claimed.");
}

export function clearChatGPTLoginLease(value, expected, options = {}) {
  if (!expected) return false;
  for (const record of leaseRecords(value, options)) {
    let { leasePath } = record;
    if (record.fixed) options.beforeRelocate?.(record.lease);
    const relocated = relocatedLeasePath(leasePath);
    try {
      // Move first, inspect second. If another generation replaced the one
      // the caller observed, it is preserved at a name every reader scans;
      // this caller never unlinks a reusable path. Relocate already-relocated
      // records as well so the final unlink targets a fresh, operation-owned
      // random name rather than one another cleanup previously observed.
      renameSync(leasePath, relocated);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    leasePath = relocated;
    let lease;
    try {
      lease = readLeaseAt(leasePath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!sameLease(lease, expected)) continue;
    try {
      unlinkSync(leasePath);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

export function chatGPTLoginLeaseStatus(value, {
  identity = processStartIdentity,
  now = Date.now(),
  maxAgeMs = CHATGPT_LOGIN_LEASE_MAX_AGE_MS,
  ...options
} = {}) {
  let stale = false;
  for (let pass = 0; pass < 3; pass += 1) {
    const records = leaseRecords(value, options);
    if (records.length === 0) return { active: false, stale };
    let changed = false;
    for (const { lease } of records) {
      const currentIdentity = identity(lease.pid);
      if (currentIdentity === lease.processIdentity) {
        return { active: true, stale: false, pid: lease.pid };
      }
      const expired = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && now - lease.createdAt > maxAgeMs;
      if ((typeof currentIdentity === "string" && currentIdentity) || expired) {
        if (clearChatGPTLoginLease(value, lease, options)) {
          stale = true;
          changed = true;
          continue;
        }
        return { active: true, stale: false, uncertain: true };
      }
      // An unavailable process probe is not proof of exit. Keep the bounded
      // lease fail closed until its deadline so a transient Windows/ps failure
      // cannot let removal race a still-running detached OAuth callback.
      return { active: true, stale: false, pid: lease.pid, uncertain: true };
    }
    if (!changed) break;
  }
  return leaseRecords(value, options).length === 0
    ? { active: false, stale }
    : { active: true, stale: false, uncertain: true };
}

export function assertChatGPTLoginLeaseInactive(value, options = {}) {
  if (chatGPTLoginLeaseStatus(value, options).active) {
    throw new Error("Cannot remove a ChatGPT account while its browser sign-in is in progress.");
  }
}

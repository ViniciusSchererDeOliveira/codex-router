import {
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const WAIT_MS = 25;
const MAX_WAIT_MS = 2_000;
const STALE_MS = 30_000;

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockPath(target) {
  return `${target}.lock`;
}

function staleLock(pathname) {
  try {
    const stat = lstatSync(pathname);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    return Date.now() - stat.mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

function acquire(target) {
  const pathname = lockPath(target);
  mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(pathname, { recursive: false, mode: 0o700 });
      try {
        writeFileSync(`${pathname}/owner`, `${process.pid}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch {
        rmSync(pathname, { recursive: true, force: true });
        throw new Error(`Could not initialize state lock: ${pathname}`);
      }
      return () => rmSync(pathname, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let link = false;
      try {
        link = lstatSync(pathname).isSymbolicLink();
      } catch {
        continue;
      }
      if (link) throw new Error(`Refusing to use a symbolic-link state lock: ${pathname}`);
      if (staleLock(pathname)) {
        rmSync(pathname, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= MAX_WAIT_MS) {
        let owner = "";
        try { owner = readFileSync(`${pathname}/owner`, "utf8").trim(); } catch { /* lock holder may be creating it */ }
        throw new Error(`Timed out waiting for state lock${owner ? ` held by ${owner}` : ""}: ${pathname}`);
      }
      sleep(WAIT_MS);
    }
  }
}

export function withAtomicStateLock(target, operation) {
  if (typeof operation !== "function") throw new TypeError("State lock operation must be a function.");
  const release = acquire(target);
  try {
    return operation();
  } finally {
    release();
  }
}

export function atomicStateLockPath(target) {
  return lockPath(target);
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { waitForServiceReadiness } from "../src/service-readiness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a persistently dead Windows task fails readiness early with its result", async () => {
  let stateQueries = 0;
  await assert.rejects(
    waitForServiceReadiness({
      platform: "win32",
      timeoutMs: 60_000,
      launchGraceMs: 20,
      pollMs: 10,
      getWindowsTaskState: () => {
        stateQueries += 1;
        return { instanceCount: 0, lastTaskResult: 1, launcherAlive: false };
      },
      waitForHealth: () => new Promise(() => {}),
    }),
    /no running launcher process \(LastTaskResult=0x1\)/,
  );
  assert.equal(stateQueries > 1, true);
});

test("a stale instance entry with no live launcher process also fails readiness early", async () => {
  await assert.rejects(
    waitForServiceReadiness({
      platform: "win32",
      timeoutMs: 60_000,
      launchGraceMs: 20,
      pollMs: 10,
      getWindowsTaskState: () => ({
        instanceCount: 1,
        lastTaskResult: 267014,
        launcherAlive: false,
      }),
      waitForHealth: () => new Promise(() => {}),
    }),
    /no running launcher process \(LastTaskResult=0x41306\)/,
  );
});

test("a live launcher process keeps the wait alive until health answers", async () => {
  const health = await waitForServiceReadiness({
    platform: "win32",
    timeoutMs: 1_000,
    launchGraceMs: 25,
    pollMs: 10,
    getWindowsTaskState: () => ({
      instanceCount: 1,
      lastTaskResult: 267009,
      launcherAlive: true,
    }),
    waitForHealth: () => new Promise((resolve) => setTimeout(resolve, 30, { ok: true })),
  });
  assert.deepEqual(health, { ok: true });
});

test("brief Task Scheduler launch lag does not reject a healthy start", async () => {
  const health = await waitForServiceReadiness({
    platform: "win32",
    timeoutMs: 1_000,
    launchGraceMs: 25,
    pollMs: 10,
    getWindowsTaskState: () => ({
      instanceCount: 0,
      lastTaskResult: 1,
      launcherAlive: false,
    }),
    waitForHealth: () => new Promise((resolve) => setTimeout(resolve, 30, { ok: true })),
  });
  assert.deepEqual(health, { ok: true });
});

test("an unavailable Task Scheduler query cannot make readiness fail closed", async () => {
  const health = await waitForServiceReadiness({
    platform: "win32",
    timeoutMs: 100,
    pollMs: 10,
    getWindowsTaskState: () => undefined,
    waitForHealth: () => Promise.resolve({ ok: true }),
  });
  assert.deepEqual(health, { ok: true });
});

test("non-Windows readiness uses only router health", async () => {
  let queried = false;
  const health = await waitForServiceReadiness({
    platform: "linux",
    timeoutMs: 100,
    getWindowsTaskState: () => {
      queried = true;
      return { instanceCount: 0, lastTaskResult: 1, launcherAlive: false };
    },
    waitForHealth: () => Promise.resolve({ ok: true }),
  });
  assert.deepEqual(health, { ok: true });
  assert.equal(queried, false);
});

test("a crash-looping Linux service fails readiness early with the log locations", async () => {
  let restarts = 0;
  const startedAt = Date.now();
  await assert.rejects(
    waitForServiceReadiness({
      platform: "linux",
      timeoutMs: 60_000,
      pollMs: 10,
      getServiceRestarts: () => ++restarts,
      waitForHealth: () => new Promise(() => {}),
    }),
    /restarted 3 times.*journalctl --user -u codex-router\.service/s,
  );
  // The early verdict must land well inside the budget, or the guard has
  // bought nothing over waiting for health to time out.
  assert.ok(Date.now() - startedAt < 30_000);
});

test("restarts counted from the value at wait start, not absolute counts", async () => {
  // A unit can carry restarts from before this install; only an increase is
  // evidence of a loop this wait observed.
  const health = await waitForServiceReadiness({
    platform: "linux",
    timeoutMs: 1_000,
    pollMs: 10,
    getServiceRestarts: () => 50,
    waitForHealth: () => new Promise((resolve) => setTimeout(resolve, 40, { ok: true })),
  });
  assert.deepEqual(health, { ok: true });
});

test("an unavailable restart count cannot make readiness fail closed", async () => {
  const health = await waitForServiceReadiness({
    platform: "linux",
    timeoutMs: 1_000,
    pollMs: 10,
    getServiceRestarts: () => {
      throw new Error("no systemd session");
    },
    waitForHealth: () => new Promise((resolve) => setTimeout(resolve, 40, { ok: true })),
  });
  assert.deepEqual(health, { ok: true });
});

test("a restart count that never climbs keeps the wait alive until health answers", async () => {
  let queries = 0;
  const health = await waitForServiceReadiness({
    platform: "linux",
    timeoutMs: 1_000,
    pollMs: 10,
    getServiceRestarts: () => {
      queries += 1;
      return 1;
    },
    waitForHealth: () => new Promise((resolve) => setTimeout(resolve, 40, { ok: true })),
  });
  assert.deepEqual(health, { ok: true });
  assert.ok(queries > 1);
});

test("health that settles as the restart threshold is reached wins over the crash-loop verdict", async () => {
  // The poll race has already given up the tick by the time the counter query
  // runs, so health can arrive inside that very query. The counter must never
  // override a verdict health has reached; this exact interleaving used to
  // throw crash-looping for a router that was already healthy.
  let restarts = 0;
  let resolveHealth;
  const healthSettled = new Promise((resolve) => {
    resolveHealth = resolve;
  });
  const health = await waitForServiceReadiness({
    platform: "linux",
    timeoutMs: 10_000,
    pollMs: 10,
    getServiceRestarts: () => {
      restarts += 1;
      if (restarts === 4) resolveHealth({ ok: true });
      return restarts;
    },
    waitForHealth: () => healthSettled,
  });
  assert.equal(restarts, 4);
  assert.deepEqual(health, { ok: true });
});

test("the final crash-loop health grace stays inside the readiness deadline", async () => {
  let queries = 0;
  const startedAt = Date.now();
  await assert.rejects(
    waitForServiceReadiness({
      platform: "linux",
      timeoutMs: 80,
      pollMs: 200,
      getServiceRestarts: () => (queries++ === 0 ? 0 : 3),
      waitForHealth: () => new Promise(() => {}),
    }),
    /crash-looping/,
  );
  assert.ok(
    Date.now() - startedAt < 180,
    "the final health grace must not add a fresh poll interval after the deadline",
  );
});

test("a restart-count query is given the remaining budget and cannot stretch the wait", async () => {
  const budgets = [];
  const startedAt = Date.now();
  await assert.rejects(
    waitForServiceReadiness({
      platform: "linux",
      timeoutMs: 150,
      pollMs: 10,
      getServiceRestarts: (remainingMs) => {
        budgets.push(remainingMs);
        return 7; // present but never climbing: no loop evidence, no early verdict
      },
      waitForHealth: () =>
        new Promise((resolve) =>
          setTimeout(resolve, 200, { ok: false, error: "router never answered" }),
        ),
    }),
    /router never answered/,
  );
  assert.ok(budgets.length > 1, "the counter must be polled while the wait runs");
  assert.ok(
    budgets.every((budget) => budget >= 0 && budget <= 150),
    "each query must receive a budget inside the wait's own timeout",
  );
  assert.ok(budgets[0] > 0, "the baseline query must still have budget");
  assert.ok(
    Date.now() - startedAt < 5_000,
    "the wait must end at its deadline, not stretch past it",
  );
});

test("a failed health result object is a failure, never a resolution", async () => {
  // `waitForRouterHealth` resolves `{ ok: false, error }` instead of
  // rejecting; the guard must surface that as a thrown failure.
  await assert.rejects(
    waitForServiceReadiness({
      platform: "win32",
      timeoutMs: 100,
      pollMs: 10,
      getWindowsTaskState: () => ({
        instanceCount: 1,
        lastTaskResult: 267009,
        launcherAlive: true,
      }),
      waitForHealth: () => Promise.resolve({ ok: false, error: "fetch failed" }),
    }),
    /fetch failed/,
  );
});

test("the service delegates its full readiness budget to the guarded wait", () => {
  const source = readFileSync(path.join(root, "src", "service.mjs"), "utf8");
  assert.match(source, /waitForServiceReadiness/);
  assert.match(source, /timeoutMs: READINESS_TIMEOUT_MS/);
  assert.doesNotMatch(source, /waitForRouterHealth/);
});

test("the Linux service manager feeds its restart counter to the readiness guard", () => {
  const service = readFileSync(path.join(root, "src", "service.mjs"), "utf8");
  assert.match(service, /getServiceRestarts/);
  assert.match(service, /restart-count/);
  assert.match(service, /service-linux\.mjs"\s*\n?\s*\?\s*\{/);
  const linux = readFileSync(path.join(root, "src", "service-linux.mjs"), "utf8");
  assert.match(linux, /"restart-count"/);
  assert.match(linux, /NRestarts/);
});

test("the Linux restart-count query is bounded inside the readiness deadline", () => {
  const service = readFileSync(path.join(root, "src", "service.mjs"), "utf8");
  assert.match(service, /RESTART_QUERY_TIMEOUT_MS = /);
  // A blocked systemctl is killed after a fixed slice capped by the wait's
  // remaining budget, and a killed query reads as inconclusive -- it can
  // never stretch the outer readiness deadline.
  assert.match(service, /timeout: Math\.min\(RESTART_QUERY_TIMEOUT_MS, remainingMs\)/);
  assert.match(service, /killSignal: "SIGKILL"/);
  assert.match(service, /if \(!\(remainingMs > 0\)\) return undefined;/);
});

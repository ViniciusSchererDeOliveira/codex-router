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

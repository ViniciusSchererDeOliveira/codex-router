import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  antigravityAgyProcessPlan,
  startAgySessionKeeper,
} from "../src/antigravity-agy-keeper.mjs";
import {
  agyProcessEnvironment,
  readAgyKeychainPassword,
  refreshAgySession,
} from "../src/antigravity-agy-session.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

function fakeTimers() {
  const timeouts = [];
  const interval = { unref() {} };
  return {
    timeouts,
    options: {
      setTimeoutFn(callback, delay) {
        const timer = { callback, delay, cleared: false, unref() {} };
        timeouts.push(timer);
        return timer;
      },
      clearTimeoutFn(timer) {
        timer.cleared = true;
      },
      setIntervalFn() {
        return interval;
      },
      clearIntervalFn(timer) {
        assert.equal(timer, interval);
      },
    },
  };
}

test("agy session keeper is a no-op when ANTIGRAVITY_SESSION_SOURCE is not agy", () => {
  const previous = process.env.ANTIGRAVITY_SESSION_SOURCE;
  try {
    delete process.env.ANTIGRAVITY_SESSION_SOURCE;
    let logged = false;
    const keeper = startAgySessionKeeper({ log: () => { logged = true; } });
    assert.equal(logged, false);
    assert.doesNotThrow(() => keeper.stop());
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_SESSION_SOURCE;
    else process.env.ANTIGRAVITY_SESSION_SOURCE = previous;
  }
});

test("agy session keeper activates and stops cleanly when ANTIGRAVITY_SESSION_SOURCE is agy", () => {
  const previous = process.env.ANTIGRAVITY_SESSION_SOURCE;
  try {
    process.env.ANTIGRAVITY_SESSION_SOURCE = "agy";
    const keeper = startAgySessionKeeper({ log: () => {} });
    assert.doesNotThrow(() => keeper.stop());
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_SESSION_SOURCE;
    else process.env.ANTIGRAVITY_SESSION_SOURCE = previous;
  }
});

test("explicit agy mode starts refresh and forwarding without a currently fresh token", () => {
  assert.deepEqual(
    antigravityAgyProcessPlan({
      configured: false,
      environment: { ANTIGRAVITY_SESSION_SOURCE: "agy" },
    }),
    { startKeeper: true, startForwarder: true },
  );
  assert.deepEqual(
    antigravityAgyProcessPlan({ configured: true, environment: {} }),
    { startKeeper: false, startForwarder: true },
  );
  assert.deepEqual(
    antigravityAgyProcessPlan({ configured: false, environment: {} }),
    { startKeeper: false, startForwarder: false },
  );
});

test("agy refresh inherits the supervisor proxy decision without unrelated environment", () => {
  const keys = [
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "all_proxy",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
    "AGY_UNRELATED_SECRET",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.HTTPS_PROXY = "http://127.0.0.1:3213";
    process.env.HTTP_PROXY = "http://127.0.0.1:3214";
    process.env.ALL_PROXY = "socks5://127.0.0.1:1080";
    process.env.NO_PROXY = "localhost,127.0.0.1";
    process.env.https_proxy = "http://127.0.0.1:4213";
    process.env.http_proxy = "http://127.0.0.1:4214";
    process.env.all_proxy = "socks5://127.0.0.1:2080";
    process.env.no_proxy = "::1";
    process.env.NODE_USE_ENV_PROXY = "0";
    process.env.AGY_UNRELATED_SECRET = "must-not-leak";

    const environment = agyProcessEnvironment("/opt/homebrew/bin/agy");
    for (const key of keys.slice(0, -1)) {
      assert.equal(environment[key], process.env[key], key);
    }
    assert.equal("AGY_UNRELATED_SECRET" in environment, false);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("agy Keychain reads have a hard timeout and bounded output", () => {
  let invocation;
  const password = readAgyKeychainPassword({
    execFile(command, args, options) {
      invocation = { command, args, options };
      return "keychain-value\n";
    },
  });
  assert.equal(password, "keychain-value");
  assert.equal(invocation.command, "/usr/bin/security");
  assert.deepEqual(invocation.args, ["find-generic-password", "-s", "gemini", "-w"]);
  assert.equal(invocation.options.timeout, 5_000);
  assert.equal(invocation.options.killSignal, "SIGKILL");
  assert.equal(invocation.options.maxBuffer, 1024 * 1024);
});

test("stopping an active agy refresh escalates from TERM to KILL", () => {
  const previous = process.env.ANTIGRAVITY_SESSION_SOURCE;
  const child = fakeChild();
  const timers = fakeTimers();
  try {
    process.env.ANTIGRAVITY_SESSION_SOURCE = "agy";
    const keeper = startAgySessionKeeper({
      readSession: ({ includeExpired } = {}) =>
        includeExpired ? { expires_in: 0 } : undefined,
      executablePath: () => "/test/agy",
      processEnvironment: () => ({}),
      spawnChild: () => child,
      refreshTimeoutMs: 45,
      terminationGraceMs: 5,
      ...timers.options,
    });

    assert.equal(timers.timeouts[0].delay, 45);
    keeper.stop();
    assert.deepEqual(child.kills, ["SIGTERM"]);
    const escalation = timers.timeouts.find((timer) => timer.delay === 5);
    assert.ok(escalation);
    assert.equal(escalation.cleared, false);
    escalation.callback();
    assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_SESSION_SOURCE;
    else process.env.ANTIGRAVITY_SESSION_SOURCE = previous;
  }
});

test("agy refresh completion settles once across error and close", () => {
  const previous = process.env.ANTIGRAVITY_SESSION_SOURCE;
  const child = fakeChild();
  const timers = fakeTimers();
  const logs = [];
  let reads = 0;
  try {
    process.env.ANTIGRAVITY_SESSION_SOURCE = "agy";
    const keeper = startAgySessionKeeper({
      log: (message) => logs.push(message),
      readSession: ({ includeExpired } = {}) => {
        reads += 1;
        return includeExpired ? { expires_in: 0 } : undefined;
      },
      executablePath: () => "/test/agy",
      processEnvironment: () => ({}),
      spawnChild: () => child,
      ...timers.options,
    });

    child.emit("error", new Error("spawn failed"));
    child.emit("close", 1, null);
    assert.equal(reads, 2);
    assert.deepEqual(logs, ["agy did not publish a fresh session after the refresh attempt."]);
    keeper.stop();
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_SESSION_SOURCE;
    else process.env.ANTIGRAVITY_SESSION_SOURCE = previous;
  }
});

test("refreshAgySession throws if agy session source is not enabled", () => {
  const previous = process.env.ANTIGRAVITY_SESSION_SOURCE;
  const prevToken = process.env.ANTIGRAVITY_TOKEN_PATH;
  try {
    delete process.env.ANTIGRAVITY_SESSION_SOURCE;
    process.env.ANTIGRAVITY_TOKEN_PATH = "/tmp/fake-token.json";
    assert.throws(
      () => refreshAgySession(),
      /The agy session source is not enabled for this router/,
    );
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_SESSION_SOURCE;
    else process.env.ANTIGRAVITY_SESSION_SOURCE = previous;
    if (prevToken === undefined) delete process.env.ANTIGRAVITY_TOKEN_PATH;
    else process.env.ANTIGRAVITY_TOKEN_PATH = prevToken;
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTER_SERVICE_RESTART_MINIMUM_MS,
  ROUTER_SERVICE_RESTART_OPERATION_MS,
  restartRouterServiceIfInstalled,
  routerServiceRestartCommand,
  routerServiceStatus,
} from "../src/router-restart.mjs";

const INSTALLED_STATUS = {
  status: 0,
  error: undefined,
  stdout: JSON.stringify({ installed: true, loaded: true, state: "running" }),
};
const NOT_INSTALLED_STATUS = { status: 1, error: undefined, stdout: "" };

test("restart instructions are exact on POSIX and Windows", () => {
  assert.equal(routerServiceRestartCommand("linux"), "./bin/control service restart");
  assert.equal(
    routerServiceRestartCommand("win32"),
    "node .\\src\\control.mjs service restart",
  );
});

test("routerServiceStatus reports an installed, loaded service", async () => {
  const seen = [];
  const spawn = (command, args) => {
    seen.push({ command, args });
    return INSTALLED_STATUS;
  };
  assert.deepEqual(await routerServiceStatus({ spawn }), {
    installed: true,
    loaded: true,
    state: "running",
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].args.at(-1) === "status");
});

test("routerServiceStatus degrades to not-installed on an unusable probe", async () => {
  for (const stdout of ["", "not json"]) {
    assert.deepEqual(await routerServiceStatus({ spawn: () => ({ status: 0, error: undefined, stdout }) }), {
      installed: false,
    });
  }
  assert.deepEqual(
    await routerServiceStatus({ spawn: () => ({ status: 1, error: undefined, stdout: "" }) }),
    { installed: false },
  );
});

test("restart is skipped when no background service is installed", async () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args.at(-1));
    return NOT_INSTALLED_STATUS;
  };
  assert.equal(await restartRouterServiceIfInstalled({ spawn }), false);
  assert.deepEqual(calls, ["status"]);
});

test("restart runs the service restart command when installed", async () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args.at(-1));
    return args.at(-1) === "status"
      ? INSTALLED_STATUS
      : { status: 0, error: undefined, stdout: JSON.stringify({ state: "running" }) };
  };
  assert.equal(await restartRouterServiceIfInstalled({ spawn }), true);
  assert.deepEqual(calls, ["status", "restart"]);
});

test("status is separately capped while restart retains its contracted absolute deadline", async () => {
  const calls = [];
  const controller = new AbortController();
  const startedAt = Date.now();
  const deadline = startedAt + 400_000;
  const spawn = (_command, args, options) => {
    calls.push({ action: args.at(-1), options });
    return args.at(-1) === "status"
      ? INSTALLED_STATUS
      : { status: 0, error: undefined, stdout: "" };
  };
  assert.equal(
    await restartRouterServiceIfInstalled({ spawn, env: {}, signal: controller.signal, deadline }),
    true,
  );
  assert.deepEqual(calls.map((call) => call.action), ["status", "restart"]);
  const [statusCall, restartCall] = calls;
  assert.ok(statusCall.options.deadline > startedAt);
  assert.ok(statusCall.options.deadline <= startedAt + 10_100);
  assert.equal(statusCall.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS, undefined);
  assert.ok(restartCall.options.deadline > startedAt + ROUTER_SERVICE_RESTART_MINIMUM_MS);
  assert.ok(restartCall.options.deadline <= startedAt + ROUTER_SERVICE_RESTART_OPERATION_MS + 100);
  assert.equal(
    restartCall.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS,
    String(restartCall.options.deadline - 10_000),
  );
  assert.equal(Object.hasOwn(statusCall.options, "timeout"), false);
  assert.equal(Object.hasOwn(restartCall.options, "timeout"), false);
});

test("the read-only status helper derives a finite capped deadline without nesting an owner", async () => {
  let options;
  const startedAt = Date.now();
  await routerServiceStatus({
    env: {},
    spawn: (_command, _args, seen) => {
      options = seen;
      return NOT_INSTALLED_STATUS;
    },
  });
  assert.ok(Number.isSafeInteger(options.deadline));
  assert.ok(options.deadline > startedAt);
  assert.ok(options.deadline <= startedAt + 10_100);
  assert.equal(options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS, undefined);
});

test("status overhead still leaves the restart child a full platform and readiness window", async () => {
  const calls = [];
  const spawn = async (_command, args, options) => {
    calls.push({ action: args.at(-1), calledAt: Date.now(), options });
    if (args.at(-1) === "status") {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return INSTALLED_STATUS;
    }
    return { status: 0, error: undefined, stdout: "" };
  };
  assert.equal(await restartRouterServiceIfInstalled({ spawn, env: {} }), true);
  const restart = calls.find((call) => call.action === "restart");
  assert.ok(restart);
  const childDeadline = Number(restart.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS);
  assert.ok(
    childDeadline - restart.calledAt >= 310_000,
    `restart child retained only ${childDeadline - restart.calledAt}ms`,
  );
});

test("an inherited nominal readiness deadline is refused before service mutation", async () => {
  const calls = [];
  await assert.rejects(
    restartRouterServiceIfInstalled({
      env: {},
      deadline: Date.now() + 300_000,
      spawn: (_command, args) => {
        calls.push(args.at(-1));
        return INSTALLED_STATUS;
      },
    }),
    (error) => error?.code === "router_operation_timeout"
      && /cannot preserve/.test(error.message),
  );
  assert.deepEqual(calls, ["status"]);
});

test("an aborted restart cannot spawn or be mistaken for an absent service", async () => {
  const controller = new AbortController();
  const aborted = new Error("planned restart abort");
  controller.abort(aborted);
  await assert.rejects(
    restartRouterServiceIfInstalled({
      signal: controller.signal,
      deadline: Date.now() + 10_000,
      spawn: () => assert.fail("an aborted restart must fail before spawning"),
    }),
    (error) => error === aborted,
  );
});

test("an expired service deadline fails instead of looking uninstalled", async () => {
  await assert.rejects(
    restartRouterServiceIfInstalled({
      deadline: Date.now() - 1,
      spawn: () => assert.fail("an expired deadline must fail before spawning"),
    }),
    (error) => error?.code === "router_operation_timeout",
  );
});

test("a failed restart fails loudly instead of pretending the route is live", async () => {
  const spawn = (command, args) =>
    args.at(-1) === "status"
      ? INSTALLED_STATUS
      : { status: 1, error: undefined, stdout: "" };
  await assert.rejects(
    restartRouterServiceIfInstalled({ spawn }),
    /could not be restarted/,
  );
});

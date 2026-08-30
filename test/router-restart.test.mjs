import assert from "node:assert/strict";
import test from "node:test";

import {
  environmentPoolRemovalReminder,
  environmentPoolMutationServiceStatus,
  restartRouterServiceIfInstalled,
  routerServiceStatus,
} from "../src/router-restart.mjs";

const INSTALLED_STATUS = {
  status: 0,
  error: undefined,
  stdout: JSON.stringify({ installed: true, loaded: true, state: "running" }),
};
const STOPPED_STATUS = {
  status: 0,
  error: undefined,
  stdout: JSON.stringify({ installed: true, loaded: false, state: "stopped" }),
};
const ABSENT_STATUS = {
  status: 0,
  error: undefined,
  stdout: JSON.stringify({ installed: false, loaded: false, state: "stopped" }),
};
const NOT_INSTALLED_STATUS = { status: 1, error: undefined, stdout: "" };

test("routerServiceStatus reports an installed, loaded service", () => {
  const seen = [];
  const spawn = (command, args) => {
    seen.push({ command, args });
    return INSTALLED_STATUS;
  };
  assert.deepEqual(routerServiceStatus({ spawn }), {
    installed: true,
    loaded: true,
    state: "running",
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].args.at(-1) === "status");
});

test("routerServiceStatus marks an unusable probe as unknown instead of absent", () => {
  for (const stdout of ["", "not json"]) {
    assert.deepEqual(routerServiceStatus({ spawn: () => ({ status: 0, error: undefined, stdout }) }), {
      installed: false,
      statusUnknown: true,
    });
  }
  assert.deepEqual(
    routerServiceStatus({ spawn: () => ({ status: 1, error: undefined, stdout: "" }) }),
    { installed: false, statusUnknown: true },
  );
  assert.deepEqual(
    routerServiceStatus({
      spawn: () => ({
        status: 0,
        error: undefined,
        stdout: JSON.stringify({ installed: false, loaded: "no", state: "stopped" }),
      }),
    }),
    { installed: false, statusUnknown: true },
  );
});

test("environment-backed pool changes refuse a running managed service before probing health", async () => {
  let healthProbes = 0;
  await assert.rejects(
    environmentPoolMutationServiceStatus({
      spawn: () => INSTALLED_STATUS,
      waitForHealth: async () => {
        healthProbes += 1;
        return { ok: false, connectionRefused: true };
      },
    }),
    (error) => {
      assert.equal(error.code, "provider_api_key_pool_service_environment_stale");
      assert.match(error.message, /stop the service/i);
      assert.match(error.message, /restart alone does not rewrite/i);
      return true;
    },
  );
  assert.equal(healthProbes, 0);

  await assert.rejects(
    environmentPoolMutationServiceStatus({
      spawn: () => ({
        status: 0,
        error: undefined,
        stdout: JSON.stringify({ installed: false, loaded: true, state: "running" }),
      }),
      waitForHealth: async () => ({ ok: false, connectionRefused: true }),
    }),
    /managed router service is running/i,
    "an orphaned loaded job is still service-owned even if its definition is missing",
  );
});

test("environment-backed pool changes allow only stopped service state plus a refused port", async () => {
  assert.deepEqual(
    await environmentPoolMutationServiceStatus({
      spawn: () => STOPPED_STATUS,
      waitForHealth: async () => ({ ok: false, connectionRefused: true }),
    }),
    {
      installed: true,
      loaded: false,
      state: "stopped",
      serviceReinstallRequired: true,
    },
  );
  assert.deepEqual(
    await environmentPoolMutationServiceStatus({
      spawn: () => ABSENT_STATUS,
      waitForHealth: async () => ({ ok: false, connectionRefused: true }),
    }),
    {
      installed: false,
      loaded: false,
      state: "stopped",
      serviceReinstallRequired: false,
    },
  );
});

test("a live foreground router blocks environment-backed pool publication", async () => {
  for (const health of [
    { ok: true, payload: { service: "codex-router" } },
    {
      ok: false,
      error: "gateway unavailable",
      degradedPayload: { service: "codex-router", degraded: ["gateway"] },
    },
  ]) {
    await assert.rejects(
      environmentPoolMutationServiceStatus({
        spawn: () => ABSENT_STATUS,
        waitForHealth: async () => health,
      }),
      (error) => {
        assert.equal(error.code, "provider_api_key_pool_service_environment_stale");
        assert.match(error.message, /live router process/i);
        assert.match(error.message, /stop the foreground router/i);
        return true;
      },
    );
  }
});

test("unknown service or ambiguous health ownership fails closed", async () => {
  await assert.rejects(
    environmentPoolMutationServiceStatus({
      spawn: () => NOT_INSTALLED_STATUS,
      waitForHealth: async () => ({ ok: false, connectionRefused: true }),
    }),
    /service state could not be verified/i,
  );

  for (const health of [
    { ok: false, error: "socket reset", connectionRefused: false },
    { ok: false, error: "request timed out" },
    { ok: false, error: "foreign response", connectionRefused: false },
  ]) {
    await assert.rejects(
      environmentPoolMutationServiceStatus({
        spawn: () => ABSENT_STATUS,
        waitForHealth: async () => health,
      }),
      (error) => {
        assert.equal(error.code, "provider_api_key_pool_service_environment_stale");
        assert.match(error.message, /process state could not be verified/i);
        return true;
      },
    );
  }
});

test("environment-backed removal reminders cover managed, unknown, and foreground ownership", () => {
  const managed = environmentPoolRemovalReminder({ installed: true, loaded: false });
  assert.match(managed, /rerun the installer/i);
  assert.match(managed, /remove the retired secret/i);
  assert.match(managed, /service definition/i);
  assert.match(managed, /restart alone/i);

  const unknown = environmentPoolRemovalReminder({ installed: false, statusUnknown: true });
  assert.match(unknown, /could not be verified/i);
  assert.match(unknown, /if one is installed, rerun the installer/i);
  assert.match(unknown, /restart alone/i);

  const loaded = environmentPoolRemovalReminder({ installed: false, loaded: true });
  assert.match(loaded, /stop and restart the loaded router process/i);

  const foreground = environmentPoolRemovalReminder({ installed: false, loaded: false });
  assert.match(foreground, /restart any foreground router/i);
  for (const reminder of [managed, unknown, loaded, foreground]) {
    assert.doesNotMatch(reminder, /OPENCODE_API_KEY|OPENCODE_GO_API_KEY|secret-test-value/);
  }
});

test("restart is skipped when no background service is installed", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args.at(-1));
    return NOT_INSTALLED_STATUS;
  };
  assert.equal(restartRouterServiceIfInstalled({ spawn }), false);
  assert.deepEqual(calls, ["status"]);
});

test("restart runs the service restart command when installed", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args.at(-1));
    return args.at(-1) === "status"
      ? INSTALLED_STATUS
      : { status: 0, error: undefined, stdout: JSON.stringify({ state: "running" }) };
  };
  assert.equal(restartRouterServiceIfInstalled({ spawn }), true);
  assert.deepEqual(calls, ["status", "restart"]);
});

test("a failed restart fails loudly instead of pretending the route is live", () => {
  const spawn = (command, args) =>
    args.at(-1) === "status"
      ? INSTALLED_STATUS
      : { status: 1, error: undefined, stdout: "" };
  assert.throws(
    () => restartRouterServiceIfInstalled({ spawn }),
    /could not be restarted/,
  );
});

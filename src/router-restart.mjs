import { spawnSync } from "node:child_process";
import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";
import { waitForRouterHealth } from "./router-health.mjs";

const SERVICE_SCRIPT = path.join(SOURCE_ROOT, "src", "service.mjs");

// The router reads its model registry at process start, so a local-model route
// added through `control local-models set` is only routable after the
// background service reloads it. Probe the service first: dev checkouts and
// test harnesses run the router in the foreground, where there is nothing to
// restart.
export function routerServiceStatus({ spawn = spawnSync, env = process.env } = {}) {
  const result = spawn(process.execPath, [SERVICE_SCRIPT, "status"], {
    cwd: SOURCE_ROOT,
    env,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return { installed: false, statusUnknown: true };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (
      typeof parsed?.installed !== "boolean" ||
      typeof parsed?.loaded !== "boolean" ||
      typeof parsed?.state !== "string"
    ) {
      return { installed: false, statusUnknown: true };
    }
    return {
      installed: parsed.installed,
      loaded: parsed.loaded,
      state: parsed.state,
    };
  } catch {
    return { installed: false, statusUnknown: true };
  }
}

function environmentMutationError(message) {
  const error = new Error(message);
  error.code = "provider_api_key_pool_service_environment_stale";
  return error;
}

// A running managed service cannot acquire a newly named shell variable from a
// restart: launchd, systemd, and Task Scheduler replay the environment already
// stored in their private definitions. Publishing an environment-backed pool
// before that definition is re-rendered would advertise models the live router
// cannot authenticate. Stage only while the service is stopped, then let the
// installer render and start it from the same environment.
export async function environmentPoolMutationServiceStatus({
  spawn = spawnSync,
  env = process.env,
  waitForHealth = waitForRouterHealth,
} = {}) {
  const status = routerServiceStatus({ spawn, env });
  if (status.statusUnknown) {
    throw environmentMutationError(
      "Cannot safely add an environment-backed API-key pool entry because the background service state could not be verified. " +
        "Repair or stop the service, then retry; publishing while ownership is unknown could expose a route that cannot authenticate.",
    );
  }
  if (status.loaded) {
    throw environmentMutationError(
      "Cannot add an environment-backed API-key pool entry while the managed router service is running. " +
        "Stop the service, repeat the command with every pooled variable set, then rerun the installer; " +
        "a restart alone does not rewrite the service environment.",
    );
  }

  let health;
  try {
    // One bounded ownership probe is enough: the service-operation lock keeps
    // a managed start out until publication completes, while the public health
    // leaf identifies an already-live foreground router without a credential.
    health = await waitForHealth({ timeoutMs: 0, requestTimeoutMs: 1_000 });
  } catch {
    health = { ok: false };
  }
  const liveRouter = health?.ok === true || health?.degradedPayload?.service === "codex-router";
  if (liveRouter) {
    throw environmentMutationError(
      "Cannot add an environment-backed API-key pool entry while a live router process is already serving. " +
        "Stop the foreground router, repeat the command from the environment containing every pooled variable, then start it again.",
    );
  }
  if (health?.connectionRefused !== true) {
    throw environmentMutationError(
      "Cannot safely add an environment-backed API-key pool entry because the router process state could not be verified. " +
        "Stop or repair the router, then retry; only a confirmed empty loopback port is safe to publish against.",
    );
  }
  return {
    ...status,
    serviceReinstallRequired: status.installed === true,
  };
}

export function environmentPoolRemovalReminder(status) {
  if (status?.installed === true) {
    return (
      "Environment-backed pool metadata removed. Rerun the installer to remove the retired secret " +
      "from the managed service definition; a service restart alone replays the old definition.\n"
    );
  }
  if (status?.statusUnknown) {
    return (
      "Environment-backed pool metadata removed. Background service status could not be verified; " +
      "if one is installed, rerun the installer to remove the retired secret from its definition; " +
      "a restart alone may replay the old definition.\n"
    );
  }
  if (status?.loaded === true) {
    return (
      "Environment-backed pool metadata removed. Stop and restart the loaded router process to " +
      "drop the retired variable from its inherited environment.\n"
    );
  }
  return (
    "Environment-backed pool metadata removed. Restart any foreground router to drop the retired " +
    "variable from its process environment.\n"
  );
}

export function restartRouterServiceIfInstalled({ spawn = spawnSync, env = process.env } = {}) {
  if (!routerServiceStatus({ spawn, env }).installed) return false;
  const result = spawn(process.execPath, [SERVICE_SCRIPT, "restart"], {
    cwd: SOURCE_ROOT,
    env,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      "The router service could not be restarted; local model routes will not go live until it is.",
    );
  }
  return true;
}

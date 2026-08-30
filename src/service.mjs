import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT } from "./paths.mjs";
import { stopManagedOllama } from "./ollama-runtime.mjs";
import { waitForServiceReadiness } from "./service-readiness.mjs";
import { withServiceOperationLock } from "./service-operation-lock.mjs";
import { environmentProxyOptedIn } from "./proxy-environment.mjs";

const platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const script = {
  darwin: "service-macos.mjs",
  linux: "service-linux.mjs",
  win32: "service-windows.mjs",
}[platform];

if (!script) {
  throw new Error(`Unsupported background-service platform: ${platform}`);
}

const mutatingCommands = new Set(["install", "uninstall", "start", "stop", "restart"]);
const readinessCommands = new Set(["install", "start", "restart"]);
const shutdownCommands = new Set(["stop", "uninstall"]);
// start.mjs allows the LiteLLM gateway 300s to cold start, so the readiness
// wait has to cover at least that. A shorter wait reports failure while the
// service is still booting, and the installer's rollback then uninstalls the
// service and reverts the app config out from under a router that goes on to
// come up healthy seconds later.
const READINESS_TIMEOUT_MS = 300_000;
// One restart-count query runs on every readiness poll, synchronously. A
// systemctl that never answers must cost the wait a bounded slice, not the
// whole readiness budget, so the query is killed and read as inconclusive.
const RESTART_QUERY_TIMEOUT_MS = 5_000;

export async function runServiceCommandUnlocked(
  command = "status",
  args = [command],
) {
  // The wrapper below is a separate Node process, so a direct
  // `node --use-env-proxy src/service.mjs ...` invocation would otherwise lose
  // its CLI-only opt-in before the platform renderer can persist it.
  const childEnvironment = {
    ...process.env,
    ...(environmentProxyOptedIn() ? { NODE_USE_ENV_PROXY: "1" } : {}),
  };
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", script), ...args],
    { stdio: "inherit", env: childEnvironment },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  // A server that was already running is external and stopManagedOllama() is
  // a no-op. Only the exact detached `ollama serve` process this router
  // started is coupled to an explicit router shutdown. Installs and restarts
  // deliberately keep it alive across the brief service handoff.
  if (shutdownCommands.has(command)) await stopManagedOllama();
  if (!readinessCommands.has(command)) return 0;

  const health = await waitForServiceReadiness({
    timeoutMs: READINESS_TIMEOUT_MS,
    // Only the Linux service manager exposes an automatic-restart counter
    // this guard can read; Windows readiness carries its own task-state
    // guard, and launchd has no equivalent counter.
    ...(script === "service-linux.mjs"
      ? {
          // The readiness guard passes whatever budget it has left, so the
          // fixed slice below can never stretch the wait past its deadline.
          getServiceRestarts: (remainingMs) => {
            if (!(remainingMs > 0)) return undefined;
            const counter = spawnSync(
              process.execPath,
              [path.join(SOURCE_ROOT, "src", script), "restart-count"],
              {
                encoding: "utf8",
                env: childEnvironment,
                timeout: Math.min(RESTART_QUERY_TIMEOUT_MS, remainingMs),
                killSignal: "SIGKILL",
              },
            );
            if (counter.error || counter.status !== 0) return undefined;
            try {
              const parsed = JSON.parse(counter.stdout);
              return typeof parsed.restarts === "number" ? parsed.restarts : undefined;
            } catch {
              return undefined;
            }
          },
        }
      : {}),
  });
  if (health.ok) return 0;
  console.error(
    `Router did not become healthy within ${READINESS_TIMEOUT_MS / 1_000} seconds: ${health.error}`,
  );
  return 1;
}

export async function runServiceCli(args = process.argv.slice(2)) {
  const command = args[0] || "status";
  const commandArgs = args.length ? args : [command];
  return mutatingCommands.has(command)
    ? withServiceOperationLock(() => runServiceCommandUnlocked(command, commandArgs))
    : runServiceCommandUnlocked(command, commandArgs);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(await runServiceCli());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

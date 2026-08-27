import path from "node:path";

import { SOURCE_ROOT } from "./paths.mjs";
import {
  operationDeadlineFromEnvironment,
  remainingOperationMs,
  runOperationProcessTree,
  runProcessTree,
} from "./process-tree.mjs";

const SERVICE_SCRIPT = path.join(SOURCE_ROOT, "src", "service.mjs");
// Status is a read-only preflight and is capped separately. Once restart
// begins, its child loses ten seconds to the process-owner cleanup reserve and
// service.mjs may spend ten more seconds in the platform renderer before the
// documented full 300-second LiteLLM readiness wait starts.
const SERVICE_STATUS_OPERATION_MS = 10_000;
const SERVICE_PROCESS_OWNER_RESERVE_MS = 10_000;
const SERVICE_PLATFORM_COMMAND_RESERVE_MS = 10_000;
const SERVICE_READINESS_ALLOWANCE_MS = 300_000;
export const ROUTER_SERVICE_RESTART_MINIMUM_MS =
  SERVICE_STATUS_OPERATION_MS
  + SERVICE_PROCESS_OWNER_RESERVE_MS
  + SERVICE_PLATFORM_COMMAND_RESERVE_MS
  + SERVICE_READINESS_ALLOWANCE_MS;
// Keep a small handoff margin so a newly-created default deadline is still
// larger than the exact minimum when the status process and restart child are
// scheduled on different event-loop turns.
export const ROUTER_SERVICE_RESTART_OPERATION_MS =
  ROUTER_SERVICE_RESTART_MINIMUM_MS + 1_000;
const SERVICE_RESTART_PHASE_MINIMUM_MS =
  SERVICE_PROCESS_OWNER_RESERVE_MS
  + SERVICE_PLATFORM_COMMAND_RESERVE_MS
  + SERVICE_READINESS_ALLOWANCE_MS;

function serviceOperationDeadline(deadline, env) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...env, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : env;
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: ROUTER_SERVICE_RESTART_OPERATION_MS,
    maximumMs: ROUTER_SERVICE_RESTART_OPERATION_MS,
  });
}

function serviceStatusDeadline(deadline, env) {
  const boundedEnvironment = Number.isSafeInteger(deadline)
    ? { ...env, CODEX_ROUTER_OPERATION_DEADLINE_MS: String(deadline) }
    : env;
  return operationDeadlineFromEnvironment(boundedEnvironment, {
    timeoutMs: SERVICE_STATUS_OPERATION_MS,
    maximumMs: SERVICE_STATUS_OPERATION_MS,
  });
}

export function routerServiceRestartCommand(platform = process.platform) {
  return platform === "win32"
    ? "node .\\src\\control.mjs service restart"
    : "./bin/control service restart";
}

function assertOperationActive(signal, deadline) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("The router operation was aborted.");
  }
  remainingOperationMs(deadline, signal, {
    message: "The router operation deadline expired before service readiness completed.",
  });
}

function assertOperationAllowance(signal, deadline, minimumMs, message) {
  const remaining = remainingOperationMs(deadline, signal, { message });
  if (remaining !== undefined && remaining < minimumMs) {
    const error = new Error(message);
    error.code = "router_operation_timeout";
    throw error;
  }
}

async function invokeService(
  args,
  {
    spawn,
    env,
    signal,
    deadline,
    stdio = "capture",
    childOwnsOperations = true,
  },
) {
  const run = spawn
    ? async (command, commandArgs, options) => spawn(command, commandArgs, {
      ...options,
      encoding: "utf8",
      ...(stdio === "inherit" ? { stdio: "inherit" } : {}),
    })
    : runProcessTree;
  const options = {
    cwd: SOURCE_ROOT,
    env,
    signal,
    deadline,
    stdio,
  };
  return childOwnsOperations
    ? runOperationProcessTree(process.execPath, [SERVICE_SCRIPT, ...args], { ...options, run })
    : run(process.execPath, [SERVICE_SCRIPT, ...args], options);
}

export async function routerServiceStatus({
  spawn,
  env = process.env,
  signal,
  deadline,
} = {}) {
  const operationDeadline = serviceStatusDeadline(deadline, env);
  assertOperationActive(signal, operationDeadline);
  const result = await invokeService(["status"], {
    spawn,
    env,
    signal,
    deadline: operationDeadline,
    childOwnsOperations: false,
  });
  assertOperationActive(signal, operationDeadline);
  if (result.error) return { installed: false };
  if (result.status !== 0) return { installed: false };
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      installed: parsed.installed === true,
      loaded: parsed.loaded === true,
      state: typeof parsed.state === "string" ? parsed.state : undefined,
    };
  } catch {
    return { installed: false };
  }
}

export async function restartRouterServiceIfInstalled({
  spawn,
  env = process.env,
  signal,
  deadline,
} = {}) {
  const operationDeadline = serviceOperationDeadline(deadline, env);
  if (!(await routerServiceStatus({
    spawn,
    env,
    signal,
    deadline: operationDeadline,
  })).installed) return false;
  // Refuse before asking the platform service manager to mutate anything. The
  // child deadline is contracted by ten seconds; what remains must still
  // cover the platform restart and the full 300-second readiness allowance.
  assertOperationAllowance(
    signal,
    operationDeadline,
    SERVICE_RESTART_PHASE_MINIMUM_MS,
    "The service operation deadline cannot preserve the full router readiness allowance.",
  );
  const result = await invokeService(["restart"], {
    spawn,
    env,
    signal,
    deadline: operationDeadline,
    stdio: "inherit",
  });
  assertOperationActive(signal, operationDeadline);
  if (result.error || result.status !== 0) {
    throw new Error(
      "The router service could not be restarted; routes requiring fresh process state " +
        `will not go live until it is. Retry with \`${routerServiceRestartCommand()}\`.`,
    );
  }
  return true;
}

import { spawn } from "node:child_process";

import {
  agyExecutablePath,
  agyProcessEnvironment,
  agyRefreshArguments,
  readAgySession,
} from "./antigravity-agy-session.mjs";

const CHECK_INTERVAL_MS = 60_000;
const REFRESH_WINDOW_SECONDS = 5 * 60;
const REFRESH_TIMEOUT_MS = 45_000;
const TERMINATION_GRACE_MS = 5_000;

export function antigravityAgyProcessPlan({
  configured = false,
  environment = process.env,
} = {}) {
  const explicitAgy = environment.ANTIGRAVITY_SESSION_SOURCE === "agy";
  return {
    startKeeper: explicitAgy,
    // An expired agy credential is deliberately absent from OAuth status, but
    // the forwarder still needs to be ready once the keeper refreshes it.
    startForwarder: explicitAgy || configured,
  };
}

export function startAgySessionKeeper({
  log = () => {},
  spawnChild = spawn,
  readSession = readAgySession,
  executablePath = agyExecutablePath,
  processEnvironment = agyProcessEnvironment,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  refreshTimeoutMs = REFRESH_TIMEOUT_MS,
  terminationGraceMs = TERMINATION_GRACE_MS,
} = {}) {
  if (!antigravityAgyProcessPlan().startKeeper) {
    return { stop() {} };
  }
  let stopped = false;
  let refreshing = false;
  let child;
  let watchdogTimer;
  let terminationTimer;

  const disarmWatchdog = () => {
    if (watchdogTimer) {
      clearTimeoutFn(watchdogTimer);
      watchdogTimer = undefined;
    }
  };

  const disarmTermination = () => {
    if (terminationTimer) {
      clearTimeoutFn(terminationTimer);
      terminationTimer = undefined;
    }
  };

  const running = (candidate) =>
    candidate && candidate.exitCode === null && candidate.signalCode === null;

  const terminate = (candidate) => {
    if (!running(candidate)) return;
    candidate.kill("SIGTERM");
    disarmTermination();
    terminationTimer = setTimeoutFn(() => {
      terminationTimer = undefined;
      if (running(candidate)) candidate.kill("SIGKILL");
    }, terminationGraceMs);
    terminationTimer.unref?.();
  };

  const check = () => {
    if (stopped || refreshing) return;
    const session = readSession({ includeExpired: true });
    if (!session || session.expires_in > REFRESH_WINDOW_SECONDS) return;
    const executable = executablePath();
    if (!executable) {
      log("agy session is near expiry, but the agy CLI was not found.");
      return;
    }
    refreshing = true;
    child = spawnChild(executable, agyRefreshArguments(), {
      env: processEnvironment(executable),
      stdio: "ignore",
      windowsHide: true,
    });
    const spawnedChild = child;
    watchdogTimer = setTimeoutFn(() => {
      if (running(spawnedChild)) {
        log("agy refresh timed out and was terminated.");
        terminate(spawnedChild);
      }
    }, refreshTimeoutMs);
    watchdogTimer.unref?.();

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      disarmWatchdog();
      disarmTermination();
      refreshing = false;
      child = undefined;
      if (!stopped && !readSession()) {
        log("agy did not publish a fresh session after the refresh attempt.");
      }
    };
    child.once("error", finish);
    child.once("close", finish);
  };

  check();
  const timer = setIntervalFn(check, CHECK_INTERVAL_MS);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      disarmWatchdog();
      clearIntervalFn(timer);
      terminate(child);
    },
  };
}

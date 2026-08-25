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

export function startAgySessionKeeper({ log = () => {} } = {}) {
  if (process.env.ANTIGRAVITY_SESSION_SOURCE !== "agy") {
    return { stop() {} };
  }
  let stopped = false;
  let refreshing = false;
  let child;
  let watchdogTimer;

  const disarmWatchdog = () => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  };

  const check = () => {
    if (stopped || refreshing) return;
    const session = readAgySession({ includeExpired: true });
    if (!session || session.expires_in > REFRESH_WINDOW_SECONDS) return;
    const executable = agyExecutablePath();
    if (!executable) {
      log("agy session is near expiry, but the agy CLI was not found.");
      return;
    }
    refreshing = true;
    child = spawn(executable, agyRefreshArguments(), {
      env: agyProcessEnvironment(executable),
      stdio: "ignore",
      windowsHide: true,
    });
    const spawnedChild = child;
    watchdogTimer = setTimeout(() => {
      if (spawnedChild && spawnedChild.exitCode === null && spawnedChild.signalCode === null) {
        log("agy refresh timed out and was terminated.");
        spawnedChild.kill("SIGTERM");
        setTimeout(() => {
          if (spawnedChild.exitCode === null && spawnedChild.signalCode === null) {
            spawnedChild.kill("SIGKILL");
          }
        }, TERMINATION_GRACE_MS).unref();
      }
    }, REFRESH_TIMEOUT_MS);
    watchdogTimer.unref();

    const finish = () => {
      disarmWatchdog();
      refreshing = false;
      child = undefined;
      if (!stopped && !readAgySession()) {
        log("agy did not publish a fresh session after the refresh attempt.");
      }
    };
    child.once("error", finish);
    child.once("close", finish);
  };

  check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();

  return {
    stop() {
      stopped = true;
      disarmWatchdog();
      clearInterval(timer);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
  };
}

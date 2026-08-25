import { spawn } from "node:child_process";

import {
  agyExecutablePath,
  agyProcessEnvironment,
  agyRefreshArguments,
  readAgySession,
} from "./antigravity-agy-session.mjs";

const CHECK_INTERVAL_MS = 60_000;
const REFRESH_WINDOW_SECONDS = 5 * 60;

export function startAgySessionKeeper({ log = () => {} } = {}) {
  let stopped = false;
  let refreshing = false;
  let child;

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
    const finish = () => {
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
      clearInterval(timer);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
    },
  };
}

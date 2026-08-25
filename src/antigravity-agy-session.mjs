import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { LAUNCH_AGENT_PATH } from "./paths.mjs";

const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_PREFIX = "go-keyring-base64:";
const AGY_REFRESH_PROMPT = "Reply with OK only.";
const AGY_REFRESH_TIMEOUT_MS = 10 * 60_000;
const AGY_ENVIRONMENT_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
];

export function agyRefreshArguments() {
  return [
    "--print",
    AGY_REFRESH_PROMPT,
    "--print-timeout",
    "10s",
    "--output-format",
    "json",
  ];
}
const AGY_METADATA_PATH = path.join(
  os.homedir(),
  ".config",
  "machiavelli",
  "antigravity",
  "auth.json",
);

function enabled() {
  if (process.env.ANTIGRAVITY_TOKEN_PATH) return false;
  if (process.platform !== "darwin") return false;
  if (process.env.ANTIGRAVITY_SESSION_SOURCE === "agy") return true;
  try {
    if (existsSync(LAUNCH_AGENT_PATH)) {
      const plist = readFileSync(LAUNCH_AGENT_PATH, "utf8");
      return /<key>\s*ANTIGRAVITY_SESSION_SOURCE\s*<\/key>[\s\n]*<string>\s*agy\s*<\/string>/.test(plist);
    }
  } catch {
    // A desktop launch may not be able to read launchd metadata.
  }
  return false;
}

export function agyExecutablePath() {
  if (process.platform !== "darwin") return undefined;
  const candidates = [
    process.env.AGY_BIN,
    path.join(os.homedir(), ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
  ].filter((value) => typeof value === "string" && value && path.isAbsolute(value));
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export function agyProcessEnvironment(executable) {
  const environment = { HOME: os.homedir() };
  for (const key of AGY_ENVIRONMENT_KEYS) {
    if (typeof process.env[key] === "string" && process.env[key]) environment[key] = process.env[key];
  }
  const directory = path.dirname(executable);
  environment.PATH = [directory, environment.PATH || "/usr/bin:/bin"].join(path.delimiter);
  return environment;
}

function metadata() {
  if (!existsSync(AGY_METADATA_PATH)) return {};
  try {
    const value = JSON.parse(readFileSync(AGY_METADATA_PATH, "utf8"));
    return {
      project_id: typeof value.project_id === "string" ? value.project_id : "",
      email: typeof value.email === "string" ? value.email : undefined,
    };
  } catch {
    return {};
  }
}

export function readAgySession({ now = Date.now, includeExpired = false } = {}) {
  if (!enabled()) return undefined;
  let raw;
  try {
    raw = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return undefined;
  }
  if (!raw.startsWith(KEYCHAIN_PREFIX)) return undefined;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(raw.slice(KEYCHAIN_PREFIX.length), "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  const token = payload?.token;
  const expiresAt = Date.parse(typeof token?.expiry === "string" ? token.expiry : "");
  if (
    typeof token?.access_token !== "string" ||
    !token.access_token ||
    typeof token?.refresh_token !== "string" ||
    !token.refresh_token ||
    !Number.isFinite(expiresAt)
  ) {
    return undefined;
  }
  const expires_at = Math.floor(expiresAt / 1_000);
  const expires_in = expires_at - Math.floor(now() / 1_000);
  if (expires_in <= 0 && !includeExpired) return undefined;
  return {
    version: 1,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at,
    expires_in,
    token_type: typeof token.token_type === "string" ? token.token_type : "Bearer",
    session_source: "agy-keychain",
    ...metadata(),
  };
}

export function refreshAgySession({ timeoutMs = AGY_REFRESH_TIMEOUT_MS } = {}) {
  if (!enabled()) {
    throw new Error("The agy session source is not enabled for this router.");
  }
  const executable = agyExecutablePath();
  if (!executable) {
    throw new Error("The agy CLI was not found. Install it or set AGY_BIN, then retry.");
  }
  const result = spawnSync(
    executable,
    agyRefreshArguments(),
    {
      encoding: "utf8",
      env: agyProcessEnvironment(executable),
      stdio: ["ignore", "ignore", "ignore"],
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    if (result.error?.code === "ETIMEDOUT") {
      throw new Error("agy did not finish refreshing its session within 10 minutes.");
    }
    throw new Error("agy could not refresh its session. Run agy once from a terminal, then retry.");
  }
  const session = readAgySession();
  if (!session) {
    throw new Error("agy finished without a usable session. Run agy once from a terminal, then retry.");
  }
  return session;
}

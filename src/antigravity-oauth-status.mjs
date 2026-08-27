import { existsSync, readFileSync } from "node:fs";

import { privateFileIsProtected } from "./file-security.mjs";
import {
  antigravityTokenPath,
  protectAntigravityToken,
  validateAntigravityToken,
} from "./antigravity-oauth-session.mjs";
import {
  agySessionSourceEnabled,
  readAgySession,
} from "./antigravity-agy-session.mjs";

// Explicit agy selection is authoritative even while its Keychain credential
// is expired or unreadable. Reporting a router-managed token in that state
// would advertise one Google account while the keeper is refreshing another.

function selectedAgySession({
  agySessionSourceEnabledImpl = agySessionSourceEnabled,
  readAgySessionImpl = readAgySession,
} = {}) {
  if (!agySessionSourceEnabledImpl()) return undefined;
  let session;
  try {
    session = readAgySessionImpl({ includeExpired: true });
  } catch {
    // Selection remains authoritative even when Keychain access itself fails.
  }
  if (!session) return { state: "invalid" };
  if (Number(session.expires_in) <= 0) return { state: "expired", session };
  try {
    return { state: "ready", session: validateAntigravityToken(session) };
  } catch {
    return { state: "invalid" };
  }
}

export function antigravityOAuthStatus(options = {}) {
  const agy = selectedAgySession(options);
  if (agy?.state === "ready") {
    return {
      configured: true,
      credentialPresent: true,
      tokenPath: "keychain://gemini",
      source: "agy keychain session",
      projectId: agy.session.project_id || undefined,
    };
  }
  if (agy) {
    const expired = agy.state === "expired";
    return {
      configured: false,
      credentialPresent: expired,
      tokenPath: "keychain://gemini",
      source: "agy keychain session",
      setup: expired
        ? "Launch agy once to refresh its session"
        : "Run agy once to restore its session",
    };
  }
  const tokenPath = antigravityTokenPath();
  if (!existsSync(tokenPath)) {
    return {
      configured: false,
      credentialPresent: false,
      tokenPath,
      setup: "Run the Antigravity sign-in flow",
    };
  }
  try {
    const token = validateAntigravityToken(JSON.parse(readFileSync(tokenPath, "utf8")));
    return {
      configured: true,
      credentialPresent: true,
      tokenPath,
      source: "router-managed Antigravity OAuth session",
      projectId: token.project_id || undefined,
    };
  } catch {
    return {
      configured: false,
      credentialPresent: true,
      tokenPath,
      setup: "Run the Antigravity sign-in flow again; the credential is invalid",
    };
  }
}

export function antigravityOAuthHealth(options = {}) {
  const agy = selectedAgySession(options);
  if (agy?.state === "ready") {
    return {
      status: "ok",
      detail: "agy keychain session available",
      projectId: agy.session.project_id || undefined,
    };
  }
  if (agy?.state === "expired") {
    return {
      status: "expired",
      detail: "agy keychain session is expired",
      fix: "Launch agy once to refresh its session",
      projectId: agy.session.project_id || undefined,
    };
  }
  if (agy) {
    return {
      status: "invalid",
      detail: "agy keychain session is unavailable or unreadable",
      fix: "Run agy once to restore its session",
    };
  }
  const tokenPath = antigravityTokenPath();
  if (!existsSync(tokenPath)) {
    return {
      status: "missing",
      detail: "no Antigravity credential file",
      fix: "Run the Antigravity sign-in flow",
    };
  }
  let value;
  try {
    value = JSON.parse(readFileSync(tokenPath, "utf8"));
  } catch {
    return {
      status: "invalid",
      detail: "Antigravity credential file is not valid JSON",
      fix: "Run the Antigravity sign-in flow again",
    };
  }
  const revoked =
    value?.access_token === "" &&
    value?.refresh_token === "" &&
    Number(value?.expires_at) === 0 &&
    Number(value?.expires_in) === 0;
  if (revoked) {
    return {
      status: "revoked",
      detail: "Antigravity OAuth session was rejected by Google",
      fix: "Run the Antigravity sign-in flow again",
    };
  }
  try {
    const token = validateAntigravityToken(value);
    if (!privateFileIsProtected(tokenPath)) {
      return {
        status: "insecure",
        detail: "Antigravity credential file permissions allow access beyond the current user",
        fix: "Run the doctor with --fix to restore owner-only permissions",
        projectId: token.project_id || undefined,
      };
    }
    const stale = Math.floor(Date.now() / 1_000) >= token.expires_at;
    return {
      status: stale ? "stale" : "ok",
      detail: stale
        ? "access token expired; it refreshes automatically on the next request"
        : "credential present",
      fix: stale ? "No action needed; the session refreshes before forwarding." : undefined,
      projectId: token.project_id || undefined,
    };
  } catch {
    return {
      status: "incomplete",
      detail: "Antigravity credential is missing a usable token",
      fix: "Run the Antigravity sign-in flow again",
    };
  }
}

export function repairAntigravityOAuthPermissions() {
  return protectAntigravityToken();
}

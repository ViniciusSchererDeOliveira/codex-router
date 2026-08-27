import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  ensureFreshAntigravitySession,
  ensureFreshAntigravityToken,
  protectAntigravityToken,
  readAntigravityToken,
  removeAntigravityToken,
  saveAntigravityToken,
  updateAntigravityToken,
  validateAntigravityToken,
} from "../src/antigravity-oauth-session.mjs";
import {
  antigravityOAuthHealth,
  antigravityOAuthStatus,
} from "../src/antigravity-oauth-status.mjs";

// The client secret is env-only and read at call time; supply a fixture so the
// refresh path can run without a real credential.
before(() => {
  process.env.ANTIGRAVITY_CLIENT_SECRET = "test-client-secret";
});
after(() => {
  delete process.env.ANTIGRAVITY_CLIENT_SECRET;
});

async function withToken(token, run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-oauth-"));
  const tokenPath = path.join(directory, "token.json");
  const write = (value) => writeFileSync(tokenPath, JSON.stringify(value), { mode: 0o600 });
  write(token);
  const previous = process.env.ANTIGRAVITY_TOKEN_PATH;
  process.env.ANTIGRAVITY_TOKEN_PATH = tokenPath;
  try {
    return await run(write, tokenPath);
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_TOKEN_PATH;
    else process.env.ANTIGRAVITY_TOKEN_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("keeps an active Antigravity token without refreshing", async () => {
  await withToken(
    {
      access_token: "active",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      let refreshes = 0;
      const token = await ensureFreshAntigravityToken({
        now: () => 1_000_000_000_000,
        fetchImpl: async () => { refreshes += 1; throw new Error("should not run"); },
      });
      assert.equal(token, "active");
      assert.equal(refreshes, 0);
    },
  );
});

test("uses a fixed 60 second refresh window", async () => {
  const now = 1_700_000_000_000;
  await withToken(
    {
      access_token: "active",
      refresh_token: "refresh",
      expires_at: Math.floor(now / 1_000) + 120,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      let refreshes = 0;
      const session = await ensureFreshAntigravitySession({
        now: () => now,
        fetchImpl: async () => { refreshes += 1; throw new Error("should not run"); },
      });
      assert.equal(session.access_token, "active");
      assert.equal(refreshes, 0);
    },
  );
});

test("rejects non-positive live-token expiry lifetimes", () => {
  assert.throws(
    () => validateAntigravityToken({
      access_token: "access",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 0,
    }),
    /invalid expiry metadata/,
  );
});

test("explicit agy mode never falls back to a valid router-managed session", async () => {
  await withToken(
    {
      access_token: "valid-managed-account",
      refresh_token: "valid-managed-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "wrong-managed-project",
    },
    async (_write, tokenPath) => {
      const expiredAgy = {
        access_token: "expired-agy-account",
        refresh_token: "expired-agy-refresh",
        expires_at: 1_000_000_000,
        expires_in: -60,
        project_id: "selected-agy-project",
        session_source: "agy-keychain",
      };
      const agyDependencies = {
        agySessionSourceEnabledImpl: () => true,
        readAgySessionImpl: ({ includeExpired = false } = {}) =>
          includeExpired ? expiredAgy : undefined,
      };

      assert.throws(
        () => readAntigravityToken(agyDependencies),
        (error) => error?.code === "oauth_unauthorized" && /agy session is expired/i.test(error.message),
      );
      assert.deepEqual(antigravityOAuthStatus(agyDependencies), {
        configured: false,
        credentialPresent: true,
        tokenPath: "keychain://gemini",
        source: "agy keychain session",
        setup: "Launch agy once to refresh its session",
      });
      assert.deepEqual(antigravityOAuthHealth(agyDependencies), {
        status: "expired",
        detail: "agy keychain session is expired",
        fix: "Launch agy once to refresh its session",
        projectId: "selected-agy-project",
      });
      assert.equal(JSON.parse(readFileSync(tokenPath, "utf8")).access_token, "valid-managed-account");
    },
  );
});

test("explicit agy mode fails closed when its keychain session is unreadable", async () => {
  await withToken(
    {
      access_token: "valid-managed-account",
      refresh_token: "valid-managed-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
    },
    async () => {
      const agyDependencies = {
        agySessionSourceEnabledImpl: () => true,
        readAgySessionImpl: () => undefined,
      };

      assert.throws(
        () => readAntigravityToken(agyDependencies),
        (error) => error?.code === "oauth_unauthorized" && /agy session is unavailable/i.test(error.message),
      );
      assert.deepEqual(antigravityOAuthStatus(agyDependencies), {
        configured: false,
        credentialPresent: false,
        tokenPath: "keychain://gemini",
        source: "agy keychain session",
        setup: "Run agy once to restore its session",
      });
      assert.deepEqual(antigravityOAuthHealth(agyDependencies), {
        status: "invalid",
        detail: "agy keychain session is unavailable or unreadable",
        fix: "Run agy once to restore its session",
      });
    },
  );
});

test("refreshes an expiring Antigravity token", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async (write) => {
      const token = await ensureFreshAntigravityToken({
        now: () => 1_999_999_999_000,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ access_token: "new", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      });
      assert.equal(token, "new");
      assert.equal(readAntigravityToken().access_token, "new");
      assert.equal(readAntigravityToken().project_id, "p");
    },
  );
});

test("writes a revoked tombstone after Google rejects the refresh", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      await assert.rejects(
        ensureFreshAntigravityToken({
          now: () => 1_999_999_999_000,
          delayImpl: async () => {},
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ error: "invalid_grant" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            ),
        }),
        /rejected/,
      );
      const tombstone = JSON.parse(readFileSync(process.env.ANTIGRAVITY_TOKEN_PATH, "utf8"));
      assert.equal(tombstone.access_token, "");
      assert.equal(tombstone.refresh_token, "");
    },
  );
});

test("does not tombstone a token for invalid_client", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      await assert.rejects(
        ensureFreshAntigravitySession({
          force: true,
          now: () => 1_999_999_999_000,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({ error: "invalid_client" }),
              { status: 401, headers: { "Content-Type": "application/json" } },
            ),
        }),
        (error) => error?.code === "oauth_refresh_failed" && error?.status === 401,
      );
      assert.equal(readAntigravityToken().access_token, "old");
      assert.equal(readAntigravityToken().refresh_token, "refresh");
    },
  );
});

test("retries transient refresh failures and honors Retry-After", async () => {
  const delays = [];
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      let attempts = 0;
      const session = await ensureFreshAntigravitySession({
        force: true,
        now: () => 1_999_999_999_000,
        random: () => 0,
        delayImpl: async (milliseconds) => delays.push(milliseconds),
        fetchImpl: async () => {
          attempts += 1;
          if (attempts < 3) {
            return new Response("{}", {
              status: 503,
              headers: { "Content-Type": "application/json", "Retry-After": "2" },
            });
          }
          return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      assert.equal(session.access_token, "new");
      assert.equal(attempts, 3);
      assert.deepEqual(delays, [2_000, 2_000]);
    },
  );
});

test("aborts an in-flight refresh when the caller disconnects", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      const controller = new AbortController();
      let started;
      const fetchStarted = new Promise((resolve) => { started = resolve; });
      const refreshing = ensureFreshAntigravitySession({
        now: () => 1_999_999_999_000,
        signal: controller.signal,
        fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
          started();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      });
      await fetchStarted;
      controller.abort(new Error("caller disconnected"));
      await assert.rejects(refreshing, /caller disconnected/);
    },
  );
});

test("caps an excessive refresh Retry-After delay", async () => {
  const delays = [];
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      let attempts = 0;
      const session = await ensureFreshAntigravitySession({
        force: true,
        now: () => 1_999_999_999_000,
        random: () => 0,
        delayImpl: async (milliseconds) => delays.push(milliseconds),
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 1) {
            return new Response("{}", {
              status: 503,
              headers: { "Content-Type": "application/json", "Retry-After": "86400" },
            });
          }
          return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      assert.equal(session.access_token, "new");
      assert.deepEqual(delays, [30_000]);
    },
  );
});

test("recovers a concurrently replaced credential instead of tombstoning it", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "old-project",
    },
    async (write) => {
      const session = await ensureFreshAntigravitySession({
        force: true,
        now: () => 1_999_999_999_000,
        delayImpl: async () => {},
        fetchImpl: async () => {
          write({
            access_token: "replacement",
            refresh_token: "new-refresh",
            expires_at: 2_000_001_000,
            expires_in: 3600,
            project_id: "new-project",
          });
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      assert.equal(session.access_token, "replacement");
      assert.equal(session.refresh_token, "new-refresh");
    },
  );
});

test("does not overwrite a concurrently replaced credential after a successful refresh", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "old-project",
    },
    async (write) => {
      const session = await ensureFreshAntigravitySession({
        force: true,
        now: () => 1_999_999_999_000,
        fetchImpl: async () => {
          write({
            access_token: "replacement",
            refresh_token: "new-refresh",
            expires_at: 2_000_001_000,
            expires_in: 3600,
            project_id: "new-project",
          });
          return new Response(JSON.stringify({ access_token: "stale-refresh", expires_in: 3600 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      assert.equal(session.access_token, "replacement");
      assert.equal(session.refresh_token, "new-refresh");
      assert.equal(readAntigravityToken().project_id, "new-project");
    },
  );
});

test("preserves concurrent project metadata when the same credential refreshes", async () => {
  const initial = {
    access_token: "old",
    refresh_token: "refresh",
    expires_at: 2_000_000_000,
    expires_in: 3600,
    project_id: "",
  };
  await withToken(initial, async (write) => {
    const session = await ensureFreshAntigravitySession({
      force: true,
      now: () => 1_999_999_999_000,
      fetchImpl: async () => {
        write({
          ...initial,
          project_id: "managed-project",
          project_source: "managed",
          project_checked_at: 1234,
          tier_id: "pro-tier",
        });
        return new Response(JSON.stringify({ access_token: "new", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    assert.equal(session.access_token, "new");
    assert.equal(session.project_id, "managed-project");
    assert.equal(session.project_source, "managed");
    assert.equal(session.project_checked_at, 1234);
    assert.equal(session.tier_id, "pro-tier");
  });
});

test("keeps a hard-valid token when a transient refresh fails", async () => {
  await withToken(
    {
      access_token: "still-valid",
      refresh_token: "refresh",
      expires_at: Math.floor(Date.now() / 1_000) + 120,
      expires_in: 3600,
      project_id: "p",
    },
    async () => {
      const token = await ensureFreshAntigravityToken({
        fetchImpl: async () => {
          throw new Error("temporary failure");
        },
      });
      assert.equal(token, "still-valid");
    },
  );
});

test("serializes save/update/remove operations and can repair file protection", async () => {
  await withToken(
    {
      access_token: "old",
      refresh_token: "refresh",
      expires_at: 2_000_000_000,
      expires_in: 3600,
      project_id: "p",
    },
    async (_write, tokenPath) => {
      await saveAntigravityToken({
        access_token: "saved",
        refresh_token: "refresh",
        expires_at: 2_000_000_000,
        expires_in: 3600,
        project_id: "p",
      });
      const updated = await updateAntigravityToken((latest) => ({
        ...latest,
        project_id: "managed",
        project_source: "managed",
      }));
      assert.equal(updated.access_token, "saved");
      assert.equal(updated.project_id, "managed");
      assert.equal(protectAntigravityToken(), tokenPath);
      assert.equal(await removeAntigravityToken(), true);
      assert.equal(await removeAntigravityToken(), false);
      assert.equal(existsSync(tokenPath), false);
    },
  );
});

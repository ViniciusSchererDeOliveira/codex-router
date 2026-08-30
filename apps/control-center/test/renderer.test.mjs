import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appRoot, "dist");

const bridgeSource = String.raw`
(() => {
  const calls = [];
  let navigationListener;
  const searchParams = new URLSearchParams(location.search);
  let usageDelayMs = Number(searchParams.get("usageDelayMs")) || 0;
  const snapshotDelayMs = Number(searchParams.get("snapshotDelayMs")) || 0;
  const providerDelayMs = Number(searchParams.get("providerDelayMs")) || 0;
  const accountDelay = searchParams.has("accountDelayMs")
    ? Number(searchParams.get("accountDelayMs")) || 0
    : null;
  const providerUsageDelay = searchParams.has("providerUsageDelayMs")
    ? Number(searchParams.get("providerUsageDelayMs")) || 0
    : null;
  const rejectAccountUsageRead = Number(searchParams.get("rejectAccountUsageRead")) || 0;
  const rejectAccountPool = searchParams.get("rejectAccountPool") === "1";
  const staleAccountFailure = searchParams.get("staleAccountFailure") === "1";
  const staleProviderUsage = searchParams.get("staleProviderUsage") === "1";
  const fallbackUsage = searchParams.get("fallbackUsage") === "1";
  const pollOnceMs = Number(searchParams.get("pollOnceMs")) || 0;
  const healthPollOnceMs = Number(searchParams.get("healthPollOnceMs")) || 0;
  const staleHealth = searchParams.get("staleHealth") === "1";
  let accountUsageReads = 0;
  let providerUsageReads = 0;
  let healthReads = 0;
  if (pollOnceMs > 0 || healthPollOnceMs > 0) {
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 5 * 60_000 && pollOnceMs > 0) return window.setTimeout(callback, pollOnceMs, ...args);
      if (delay === 1_000 && healthPollOnceMs > 0) return window.setTimeout(callback, healthPollOnceMs, ...args);
      return nativeSetInterval(callback, delay, ...args);
    };
  }
  const subagents = { mode: "all", enabled: [], disabled: [], efforts: {}, proofs: {} };
  const selectedModel = {
    slug: "deepseek/deepseek-chat",
    displayName: "DeepSeek Chat",
    description: "Selected route used by the renderer fixture.",
    provider: "deepseek",
    enabled: true,
    visible: true,
    multiAgentVersion: "v2",
    subagentCertification: "v2",
    reasoningLevels: ["low", "medium", "high"],
    contextWindow: 128000,
    inputModalities: ["text"],
  };
  const oxProviders = [
    { id: "commandcode", displayName: "Command Code", kind: "api", configured: false },
    { id: "nousresearch", displayName: "Nous Research", kind: "api", configured: false },
    { id: "opencode-free", displayName: "OpenCode Free", kind: "anonymous", configured: true },
    { id: "opencode-go", displayName: "opencode Go/Zen", kind: "api", configured: true },
    { id: "openrouter", displayName: "OpenRouter", kind: "api", configured: false },
    { id: "venice", displayName: "Venice", kind: "api", configured: false },
  ];
  const knownOxModels = oxProviders.map((provider) => ({
    slug: provider.id + "/ox-alpha",
    displayName: "Ox Alpha (" + provider.displayName + ")",
    provider: provider.id,
    available: provider.id === "opencode-free" || provider.id === "opencode-go",
    contextWindow: 1048576,
    inputModalities: ["text", "image"],
    isFree: true,
  }));
  const activeOxModels = knownOxModels.filter((model) => model.available).map((model) => ({
    ...model,
    enabled: true,
    visible: false,
    multiAgentVersion: "v1",
    subagentCertification: "unknown",
  }));
  const target = {
    target: "codex",
    configured: true,
    active: true,
    enabledProviders: ["deepseek", "opencode-free", "opencode-go"],
    providers: [
      { id: "deepseek", displayName: "DeepSeek", kind: "api" },
      { id: "kilo-free", displayName: "Kilo Free", kind: "anonymous" },
      ...oxProviders.map(({ id, displayName, kind }) => ({ id, displayName, kind })),
    ],
    models: [selectedModel, ...activeOxModels],
    modelSettings: {
      subagents,
      picker: { hidden: [], visible: [selectedModel.slug], hasExplicitVisibility: true },
      localModels: {
        available: [],
        availableVision: [],
        availableExplore: [{
          tag: "hf.co/unsloth/GLM-5.3-Flash-GGUF:UD-IQ1_S",
          family: "hf.co/unsloth/GLM-5.3-Flash-GGUF",
          variant: "UD-IQ1_S",
          displayName: "GLM-5.3-Flash · UD-IQ1_S",
          sizeGb: 93.1,
          context: 1048576,
          fit: "too-large",
          diskFit: "fits",
          downloadable: true,
          researchStatus: "Unsloth GGUF · 7 local quants",
          researchCapabilities: ["vision", "tools", "thinking"],
          researchNote: "Community quantization; capability and Codex checks run after pull.",
        }],
        families: [{
          family: "hf.co/unsloth/GLM-5.3-Flash-GGUF",
          displayName: "GLM-5.3-Flash",
          variants: ["UD-IQ1_S"],
        }],
        installed: 0,
        enabled: 0,
        models: [],
        totalGb: 0,
        machine: "16 GB unified memory",
        runtime: { installed: true, running: true, managed: true, version: "test" },
      },
      visionBridge: { enabled: false },
    },
  };
  const snapshot = {
    targets: { codex: target },
    catalog: {
      source: "codex-router",
      configured: true,
      enabledProviders: ["deepseek", "opencode-free", "opencode-go"],
      models: [selectedModel, ...activeOxModels],
      knownModels: knownOxModels,
      picker: { hidden: [], visible: [selectedModel.slug], hasExplicitVisibility: true },
      subagents,
    },
    chatgptSession: { sharing: "disabled", session: "unavailable", present: false },
  };
  const providers = {
    providers: [
      {
        id: "deepseek",
        displayName: "DeepSeek",
        kind: "api",
        configured: true,
        action: "ready",
        credentialLabel: "DeepSeek API key",
        catalogSources: [{ id: "deepseek", displayName: "DeepSeek", kind: "models-endpoint" }],
      },
      {
        id: "kilo-free",
        displayName: "Kilo Free",
        kind: "anonymous",
        configured: true,
        action: "anonymous",
        credentialLabel: "No API key",
        catalogSources: [{ id: "kilo-free", displayName: "Kilo Free", kind: "models-endpoint" }],
      },
      ...oxProviders.map((provider) => ({
        ...provider,
        action: provider.configured ? "ready" : "provider-key",
        credentialLabel: provider.kind === "anonymous" ? "No API key" : provider.displayName + " API key",
      })),
    ],
  };

  const record = (name, ...args) => calls.push({ name, args });
  const catalog = (providerId) => {
    record("discoverProviderModels", providerId);
    if (providerId === "kilo-free") {
      return {
        provider: providerId,
        discovered: ["kilo-unselected-free"],
        registered: [],
        unregistered: ["kilo-unselected-free"],
        addable: ["kilo-unselected-free"],
        blocked: {},
        unavailable: [],
        free: ["kilo-unselected-free"],
      };
    }
    return {
      provider: providerId,
      discovered: ["catalog-addable", "blocked-preview"],
      registered: [],
      unregistered: ["catalog-addable", "blocked-preview"],
      addable: ["catalog-addable"],
      blocked: { "blocked-preview": "No certified protocol route is available." },
      unavailable: [],
      contextLengths: { "catalog-addable": 200000, "blocked-preview": 128000 },
      fetchedAt: "2026-08-24T00:00:00.000Z",
    };
  };

  window.routerControl = Object.freeze({
    platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : "linux",
    getSnapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, snapshotDelayMs));
      return snapshot;
    },
    getChatGptSession: async () => ({ sharing: "disabled", session: "usable", present: true, email: "primary@example.com" }),
    getChatGptAccountPool: async () => {
      if (rejectAccountPool) throw new Error("The saved ChatGPT account list could not be read as JSON.");
      return {
        version: 1,
        policy: { enabled: true, mode: "switch", selectedAccountId: "active" },
        accounts: {
          revoked: { id: "revoked", state: "revoked", paused: true, priority: 50, label: "Removed account", health: { state: "healthy" }, turns: 0, requests: 0 },
          active: { id: "active", state: "active", paused: false, priority: 50, label: "Secondary account", subscription: { status: "usable", authenticated: true, usable: true, expired: false, email: "secondary@example.com" }, health: { state: "healthy" }, turns: 0, requests: 0 },
          current: { id: "current", state: "active", paused: false, priority: 50, label: "Current account", subscription: { status: "usable", authenticated: true, usable: true, expired: false, email: "primary@example.com" }, health: { state: "healthy" }, turns: 0, requests: 0 },
        },
        sessions: { count: 0 },
        profile: { desired: "active", active: "active", pending: false, running: false },
      };
    },
    getProviders: async () => {
      await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
      return providers;
    },
    getPresence: async () => ({ mode: "always" }),
    getHealth: async () => {
      healthReads += 1;
      const read = healthReads;
      await new Promise((resolve) => setTimeout(resolve, staleHealth && read === 1 ? 400 : 0));
      return staleHealth && read === 1
        ? { ok: false, error: "Stale health response", activity: { state: "offline", active: [], activeCount: 0 } }
        : { ok: true, version: "health-" + read, activity: { state: "idle", active: [], activeCount: 0 } };
    },
    getAccountUsage: async () => {
      accountUsageReads += 1;
      const read = accountUsageReads;
      await new Promise((resolve) => setTimeout(
        resolve,
        staleAccountFailure && read > 1 ? 0 : accountDelay ?? usageDelayMs,
      ));
      if ((staleAccountFailure && read === 1) || rejectAccountUsageRead === read) {
        throw new Error("Account usage poll failed");
      }
      return {
        fetchedAt: "2026-08-27T08:00:00.000Z",
        planType: "pro",
        primary: {
          usedPercent: 34,
          remainingPercent: 66,
          windowDurationMins: 300,
          resetsAt: 1800000000,
        },
        dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: 24000 }],
        summary: { lifetimeTokens: 24000, peakDailyTokens: 24000, currentStreakDays: 1 },
      };
    },
    getProviderUsage: async () => {
      providerUsageReads += 1;
      const read = providerUsageReads;
      await new Promise((resolve) => setTimeout(
        resolve,
        staleProviderUsage && read > 1 ? 0 : providerUsageDelay ?? usageDelayMs,
      ));
      const totalTokens = staleProviderUsage && read > 1 ? 24000 : 12000;
      return {
        fetchedAt: "2026-08-27T08:00:00.000Z",
        providers: [
          ...(fallbackUsage ? [{
            id: "openai",
            displayName: "OpenAI",
            credentialType: "oauth",
            totalTokens: 31_000,
            requests: 3,
            last24hTokens: 31_000,
            last24hRequests: 3,
            dailyUsageBuckets: [{
              startDate: "2026-08-28",
              tokens: 31_000,
              requests: 3,
              inputTokens: 25_000,
              cachedInputTokens: 7_000,
              outputTokens: 6_000,
            }],
          }] : []),
          {
            id: "deepseek",
            displayName: "DeepSeek",
            credentialType: "api",
            totalTokens,
            requests: 8,
            last24hTokens: totalTokens,
            last24hRequests: 8,
            dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: totalTokens, requests: 8 }],
            account: {
              status: "available",
              metrics: [
                {
                  kind: "quota",
                  label: "Monthly credits",
                  usedPercent: 25,
                  remainingPercent: 75,
                  resetAt: 1800000000,
                },
                {
                  kind: "quota",
                  label: "Rolling window",
                  usedPercent: 40,
                  remainingPercent: 60,
                  resetAt: 1790000000,
                },
              ],
            },
          },
        ],
      };
    },
    controlTray: async () => ({ status: { supported: true } }),
    discoverProviderModels: async (providerId) => catalog(providerId),
    addProviderModels: async (providerId, modelIds) => {
      record("addProviderModels", providerId, [...modelIds]);
      return { ok: true };
    },
    setPickerModels: async (showAll) => {
      record("setPickerModels", showAll);
      return { ok: true };
    },
    setPickerModel: async () => ({ ok: true }),
    setProviderEnabled: async () => ({ ok: true }),
    setChatGptAccountSelection: async (selection) => {
      record("setChatGptAccountSelection", selection);
      return { ok: true };
    },
    setSubagentModel: async () => ({ ok: true }),
    setSubagentEffort: async () => ({ ok: true }),
    onNavigation: (listener) => {
      navigationListener = listener;
      return () => { if (navigationListener === listener) navigationListener = undefined; };
    },
    onOperation: () => () => {},
  });
  window.routerControlTest = Object.freeze({
    calls: () => calls.map((call) => ({ name: call.name, args: call.args })),
    navigationReady: () => Boolean(navigationListener),
    navigate: (destination) => {
      if (!navigationListener) return false;
      navigationListener(destination);
      return true;
    },
    setUsageDelay: (milliseconds) => { usageDelayMs = milliseconds; },
    usageReads: () => ({ account: accountUsageReads, provider: providerUsageReads }),
    healthReads: () => healthReads,
  });
})();
`;

function mimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function serveRenderer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/test-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bridgeSource);
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(dist, relative);
    if (target !== dist && !target.startsWith(`${dist}${path.sep}`) || !existsSync(target)) {
      response.writeHead(404).end("not found");
      return;
    }
    let contents = readFileSync(target);
    if (relative === "index.html") {
      const html = contents.toString("utf8");
      assert.match(html, /<script type="module"/);
      contents = Buffer.from(
        html.replace('<script type="module"', '<script src="./test-bridge.js"></script><script type="module"'),
      );
    }
    response.writeHead(200, { "content-type": mimeType(target) });
    response.end(contents);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => {
          server.close(done);
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

const chromiumPath = [
  process.env.CODEX_ROUTER_TEST_CHROMIUM,
  chromium.executablePath(),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
].find((candidate) => candidate && existsSync(candidate));

test("the production renderer exposes model discovery and picker actions", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    // Windows hosted runners routinely spend about 30 seconds starting the
    // browser. Keep UI waits short and diagnostic without letting that startup
    // consume the whole integration-test deadline.
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Control center sections" }).waitFor();
    const wordmark = page.locator(".router-wordmark");
    assert.equal((await wordmark.locator("strong").innerText()).trim(), "Codex Router");
    assert.equal(await wordmark.locator("img").count(), 0);
    await page.waitForFunction(() => window.routerControlTest.navigationReady());
    await page.evaluate(() => window.routerControlTest.setUsageDelay(600));
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "deepseek" })),
      true,
    );
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage-resets", sourceId: "deepseek" })),
      true,
    );
    await page.waitForFunction(() => {
      const active = document.activeElement;
      return active?.classList.contains("us-metric-card")
        && active.getAttribute("aria-label")?.startsWith("DeepSeek, Rolling window");
    });
    assert.match(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      /DeepSeek, Rolling window.*Resets/,
    );
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "openai" })),
      true,
    );
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Usage overview");
    assert.equal(await page.getByLabel("Usage source").inputValue(), "chatgpt-subscription");
    await page.getByRole("button", { name: "Models", exact: true }).click();

    // The connections strip carries every account: connected providers as
    // chips, the rest behind one menu.
    const connections = page.locator(".pm-connections");
    await connections.waitFor();
    assert.match(await connections.innerText(), /3 of 8 connected/);
    assert.deepEqual(
      (await connections.locator(".pm-chip:not(.pm-chip-add)").allTextContents()).map((text) => text.trim()).sort(),
      ["DeepSeek", "OpenCode Free", "opencode Go/Zen"].sort(),
    );
    await connections.getByRole("button", { name: "Connect provider", exact: true }).click();
    const connectMenu = page.locator(".pm-connect-menu");
    await connectMenu.waitFor();
    // An anonymous endpoint is not connected until it is explicitly enabled,
    // so it belongs with the providers still waiting for a connection.
    assert.match(await connectMenu.innerText(), /Kilo Free/);
    assert.equal(await connectMenu.getByRole("menuitem").count(), 5);
    await page.keyboard.press("Escape");

    // A single-route model's thinking menu opens below its definition-list
    // cell. The menu used to be clipped by that cell's generic text-overflow
    // rule, leaving only its top edge visible.
    const selectedFamily = page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" });
    await selectedFamily.locator(".pm-family-open").click();
    const thinkingTrigger = selectedFamily.getByRole("button", {
      name: "DeepSeek Chat DeepSeek subagent thinking effort",
    });
    await thinkingTrigger.click();
    const thinkingMenu = selectedFamily.locator(".pm-effort-menu");
    await thinkingMenu.waitFor();
    const detailsCell = selectedFamily.locator(".pm-model-details-controls");
    assert.equal(await detailsCell.evaluate((element) => getComputedStyle(element).overflow), "visible");
    const [cellBox, menuBox] = await Promise.all([detailsCell.boundingBox(), thinkingMenu.boundingBox()]);
    assert.ok(cellBox && menuBox);
    assert.ok(menuBox.y + menuBox.height > cellBox.y + cellBox.height);
    assert.equal(await page.evaluate(({ x, y }) => (
      Boolean(document.elementFromPoint(x, y)?.closest(".pm-effort-menu"))
    ), {
      x: menuBox.x + menuBox.width / 2,
      y: menuBox.y + menuBox.height - 2,
    }), true);
    await page.keyboard.press("Escape");
    await selectedFamily.locator(".pm-family-open").click();

    // A route that is only known to the registry still has to be findable, and
    // has to say which connection it is waiting for.
    const modelSearch = page.locator('input[placeholder="Search models"]');
    await modelSearch.fill("Ox Alpha");
    const oxFamily = page.locator(".pm-family-row").filter({ hasText: "Ox Alpha" });
    await oxFamily.waitFor();
    assert.match(await oxFamily.innerText(), /6 providers/);
    assert.match(await oxFamily.innerText(), /6 routes/i);
    await oxFamily.locator(".pm-family-open").click();
    assert.equal(await oxFamily.locator(".pm-route-row").count(), 6);
    assert.equal(await oxFamily.locator('.pm-route-row[data-availability="known"]').count(), 4);
    // Every row ends in the same slot: a switch you can use, or the button
    // that would make it usable.
    assert.equal(await oxFamily.getByRole("button", { name: /^Connect / }).count(), 4);
    const columns = await oxFamily.locator(".pm-route-head > span").allTextContents();
    assert.deepEqual(columns, ["Account", "Context", "Input", "In picker", "Subagents", "Thinking"]);
    await modelSearch.fill("");

    // Adding reads every connected provider's catalog at once. Only a provider
    // that is both connected and publishes a catalog is asked.
    await page.getByRole("button", { name: "Add models", exact: true }).click();
    const addDialog = page.locator(".pm-add-models");
    await addDialog.waitFor();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "discoverProviderModels"));
    const bulkCatalogProviders = await page.evaluate(() => window.routerControlTest.calls()
      .filter((call) => call.name === "discoverProviderModels")
      .map((call) => call.args[0]));
    assert.deepEqual(bulkCatalogProviders, ["deepseek"]);

    const blockedRow = addDialog.locator(".pm-add-models-row").filter({ hasText: "blocked-preview" });
    await blockedRow.waitFor();
    assert.equal(await blockedRow.getAttribute("data-blocked"), "true");
    assert.equal(await blockedRow.locator("input[type=checkbox]").isDisabled(), true);
    assert.equal(await blockedRow.getByText("Not yet supported", { exact: true }).count(), 1);
    assert.equal(
      await blockedRow.locator(".pm-catalog-block-reason").innerText(),
      "No certified protocol route is available.",
    );

    const addableRow = addDialog.locator(".pm-add-models-row").filter({ hasText: "catalog-addable" });
    await addableRow.locator("input[type=checkbox]").check();
    await addDialog.getByRole("button", { name: "Add 1 model", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "addProviderModels"));

    // Flipping a model must never move it. Sorting by the switch would throw
    // the row across the list at the moment the reader looks for confirmation.
    const modelNames = () => page.locator(".pm-family-main > strong").allTextContents();
    const orderBefore = await modelNames();
    assert.deepEqual(orderBefore, ["DeepSeek Chat", "Ox Alpha"]);
    const deepseekRow = page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" });
    assert.equal((await deepseekRow.locator(".pm-family-state").innerText()).trim(), "On");
    await deepseekRow.locator('.pm-family-action input[type="checkbox"]').click();
    // Scope to the row's own state, not any "Off" inside its expanded panel.
    await deepseekRow.locator(".pm-family-state").filter({ hasText: "Off" }).waitFor();
    assert.deepEqual(await modelNames(), orderBefore);

    // Bulk switches live behind the overflow menu, off the main toolbar.
    await page.getByRole("button", { name: "More model actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Turn all on", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "setPickerModels" && call.args[0] === true));

    const calls = await page.evaluate(() => window.routerControlTest.calls());
    assert.deepEqual(calls.find((call) => call.name === "addProviderModels")?.args, [
      "deepseek",
      ["catalog-addable"],
    ]);
    assert.equal(calls.some((call) => call.name === "setPickerModels" && call.args[0] === true), true);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const accountRows = page.locator(".subscription-account-row");
    await page.getByText("ChatGPT accounts", { exact: true }).waitFor();
    assert.equal(await accountRows.count(), 2, "two logged-in accounts should be visible");
    assert.equal(await accountRows.filter({ hasText: "Removed account" }).count(), 0, "revoked accounts stay hidden");
    assert.equal(await accountRows.filter({ hasText: "secondary@example.com" }).count(), 1, "secondary email should be visible");
    const readySecondary = accountRows.filter({ hasText: "Secondary account" });
    assert.equal(await readySecondary.getByRole("button", { name: "Login", exact: true }).isDisabled(), true, "ready accounts cannot start a duplicate login");
    await page.getByRole("button", { name: "Select ChatGPT account: primary@example.com", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "setChatGptAccountSelection" && call.args[0] === "current"));

    // Huge community GGUFs stay guarded, but the explicit oversized-model
    // acknowledgement must make their exact Ollama tag selectable. Otherwise
    // the catalog advertises GLM while forcing the operator to retype it.
    await page.getByRole("button", { name: "Local", exact: true }).click();
    await page.getByRole("heading", { name: "Local", exact: true }).waitFor();
    const glmFamily = page.locator(".lhc-catalog-family").filter({ hasText: "GLM-5.3-Flash" });
    await glmFamily.locator(".lhc-catalog-family-trigger").click();
    const glmRow = glmFamily.locator(".lhc-catalog-model").filter({ hasText: "UD-IQ1_S" });
    const glmSelect = glmRow.getByRole("button", { name: "Select", exact: true });
    assert.equal(await glmSelect.isDisabled(), true);
    await page.getByRole("checkbox", { name: "Allow a model larger than the router recommends for this machine" }).check();
    assert.equal(await glmSelect.isEnabled(), true);
    await glmSelect.click();
    assert.equal(
      await page.getByRole("textbox", { name: "Model tag or Ollama URL" }).inputValue(),
      "hf.co/unsloth/GLM-5.3-Flash-GGUF:UD-IQ1_S",
    );

    const corruptPoolPage = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    const corruptPoolErrors = [];
    corruptPoolPage.setDefaultTimeout(10_000);
    corruptPoolPage.on("pageerror", (error) => corruptPoolErrors.push(error.message));
    await corruptPoolPage.goto(`${url}?rejectAccountPool=1`, { waitUntil: "domcontentloaded" });
    await corruptPoolPage.getByRole("button", { name: "Settings", exact: true }).click();
    const accountFailure = corruptPoolPage.getByText("ChatGPT account state unavailable", { exact: true });
    await accountFailure.waitFor();
    assert.match(await corruptPoolPage.locator("body").innerText(), /could not be read as JSON/i);
    assert.equal(
      await corruptPoolPage.getByText("No saved ChatGPT accounts", { exact: true }).count(),
      0,
      "a corrupt protected pool must not be rendered as an empty first-run pool",
    );
    assert.equal(
      await corruptPoolPage.getByRole("button", { name: "Add account", exact: true }).isDisabled(),
      true,
    );
    assert.deepEqual(corruptPoolErrors, []);
    await corruptPoolPage.close();
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("fallback-only splits do not claim account breakdown or a complete range mix", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?fallbackUsage=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => window.routerControlTest.navigationReady());
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "openai" })),
      true,
    );
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('select[aria-label="Usage source"]')?.value === "chatgpt-subscription");
    await page.locator(".us-chart-token-bars rect.router-fallback").first().waitFor();
    await page.getByText(/1 date uses local router fallback\.$/).waitFor();
    await page.getByText(/1 date is filled from this router's local ChatGPT meter/).waitFor();
    assert.equal(
      await page.locator(".us-chart-wrap").getAttribute("aria-label"),
      "Daily account token usage with local router fallback on 1 date",
    );
    assert.doesNotMatch(await page.locator("body").innerText(), /\b1 dates\b/i);

    assert.equal(
      await page.getByText("The account API supplied the input/cache/output split for this 30-day range.", { exact: true }).count(),
      0,
    );
    await page.getByText(
      "OpenAI supplies daily account totals only here; use “This router · all providers” for regular input, cached input, and output.",
      { exact: true },
    ).waitFor();
    assert.equal(await page.locator('.us-token-mix[aria-label="Token mix for selected 30-day range"]').count(), 0);
    assert.equal(await page.locator(".us-token-mix").count(), 0);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("independent control-center reads reveal each ready page region", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?snapshotDelayMs=3000&accountDelayMs=4000`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    // Only the responsiveness checks use the tight budget. A cold browser
    // navigation includes process and module startup and needs a normal timeout.
    page.setDefaultTimeout(1_500);
    await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
    await page.locator(".service-health-strip").waitFor();
    await page.locator('.db-breakdown-list[aria-label="Providers usage breakdown"]')
      .getByText("DeepSeek", { exact: true })
      .waitFor();
    assert.equal(await page.locator(".db-breakdown-panel .panel-skeleton").count(), 0);

    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.getByRole("heading", { name: "Models", exact: true }).waitFor();
    const connections = page.locator(".pm-connections:not(.pm-connections-loading)");
    await connections.waitFor();
    assert.match(await connections.innerText(), /DeepSeek/);
    await page.locator(".pm-models-loading").waitFor();

    page.setDefaultTimeout(7_000);
    await page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" }).waitFor();
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("usage polling surfaces current rejections, recovers, and ignores older results", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?providerUsageDelayMs=400&staleProviderUsage=1&rejectAccountUsageRead=2&pollOnceMs=50`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => {
      const reads = window.routerControlTest.usageReads();
      return reads.account >= 2 && reads.provider >= 2;
    });
    await page.getByText("Account usage poll failed", { exact: true }).waitFor();
    await page.waitForTimeout(450);
    assert.equal(
      await page.locator('.db-breakdown-list[aria-label="Providers usage breakdown"] .db-breakdown-value').innerText(),
      "24k",
    );
    await page.getByRole("button", { name: "Refresh all data", exact: true }).click();
    await page.getByText("Account usage poll failed", { exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("an older rejected usage read cannot replace a newer success with a warning", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?accountDelayMs=400&staleAccountFailure=1&pollOnceMs=50`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => window.routerControlTest.usageReads().account >= 2);
    await page.waitForTimeout(450);
    assert.equal(await page.getByText("Account usage poll failed", { exact: true }).count(), 0);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("health polling and core refresh share latest-wins ordering", { timeout: 120_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?staleHealth=1&healthPollOnceMs=50`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => window.routerControlTest.healthReads() >= 2);
    await page.waitForTimeout(450);
    assert.match(await page.locator(".service-health-strip").innerText(), /ALL CLEAR/);
    assert.match(
      await page.getByRole("listitem", { name: /^Router state:/ }).getAttribute("aria-label"),
      /version health-2/,
    );
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

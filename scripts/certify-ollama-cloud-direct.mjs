#!/usr/bin/env node
// Direct exact-route certification against the configured Ollama-compatible
// endpoint. This intentionally bypasses the local router so it can certify a
// candidate model while an older installed checkout is still running.
//
// The provider registry and credential resolver remain the authority for the
// endpoint, model identity, and credential sources. Nothing from those sources
// is included in the report.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXACT_ROUTE_PROBE_HEADER } from "../src/exact-route-probe.mjs";
import {
  CHECKED_IN_MODELS,
  PROVIDERS,
  resolveProviderBaseUrl,
} from "../src/model-registry.mjs";
import { resolveProviderCredential } from "../src/provider-credentials.mjs";

const PROVIDER_ID = "ollama-cloud";
const MARKER = "CODEX_ROUTER_EXACT_OK";
const REQUEST_TIMEOUT_MS = 180_000;

function provider() {
  const value = PROVIDERS.get(PROVIDER_ID);
  if (!value?.baseUrl) throw new Error("Ollama Cloud provider configuration unavailable.");
  return value;
}

// Resolve a checked-in route from either its public slug or its provider model
// id. Accepting both keeps this probe convenient for existing certification
// notes while ensuring arbitrary input is never echoed into the report.
export function resolveTargetModel(value) {
  const requested = String(value || "").trim();
  const target = CHECKED_IN_MODELS.find(
    (model) => model.provider === PROVIDER_ID && model.slug === requested,
  ) || CHECKED_IN_MODELS.find(
    (model) => model.provider === PROVIDER_ID && model.upstreamModel === requested,
  );
  if (target) {
    return { slug: target.slug, upstreamModel: target.upstreamModel };
  }
  throw new Error("Pass a registered Ollama Cloud model slug or upstream model id.");
}

export function loadCredential() {
  let credential;
  try {
    credential = resolveProviderCredential(PROVIDER_ID);
  } catch {
    throw new Error("Ollama Cloud credential unavailable.");
  }
  if (typeof credential?.value !== "string" || !credential.value.trim()) {
    throw new Error("Ollama Cloud credential unavailable.");
  }
  return credential.value.trim();
}

function baseUrl() {
  try {
    return resolveProviderBaseUrl(provider()).baseUrl.replace(/\/+$/, "");
  } catch {
    throw new Error("Ollama Cloud provider configuration unavailable.");
  }
}

async function callChat(key, url, body) {
  const response = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // This is harmless to the upstream and keeps direct and routed probes
      // visibly tied to the repository's exact-route convention.
      [EXACT_ROUTE_PROBE_HEADER]: "1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  return { response, text };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function httpDetail(status) {
  return Number.isInteger(status) && status > 0 ? `HTTP ${status}` : "request failed";
}

async function runCheck(name, operation) {
  try {
    return { name, ...(await operation()) };
  } catch {
    // Do not print exception text: filesystem errors can contain local paths,
    // and transport errors can contain implementation-specific data.
    return { name, ok: false, status: undefined, detail: "request failed" };
  }
}

async function basic(key, url, model) {
  const { response, text } = await callChat(key, url, {
    model,
    messages: [{ role: "user", content: `Reply with exactly ${MARKER} and nothing else.` }],
    stream: false,
  });
  const payload = parseJson(text);
  const content = payload?.choices?.[0]?.message?.content;
  const markerReceived = typeof content === "string" && content.includes(MARKER);
  return {
    ok: response.ok && markerReceived,
    status: response.status,
    detail: response.ok ? (markerReceived ? "exact marker verified" : "marker missing") : httpDetail(response.status),
  };
}

async function streaming(key, url, model) {
  const { response, text } = await callChat(key, url, {
    model,
    messages: [{ role: "user", content: `Reply with exactly ${MARKER} and nothing else.` }],
    stream: true,
  });
  const sawDone = /data:?\s*\[DONE\]/.test(text);
  const streamedText = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => parseJson(line)?.choices?.[0]?.delta?.content || "")
    .join("");
  const markerReceived = streamedText.includes(MARKER);
  return {
    ok: response.ok && sawDone && markerReceived,
    status: response.status,
    detail: response.ok
      ? (sawDone && markerReceived ? "stream text and [DONE] completion verified" : "stream completion incomplete")
      : httpDetail(response.status),
  };
}

const TOOL = {
  type: "function",
  function: {
    name: "codex_router_probe",
    description: "Compatibility probe",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
};

async function forcedTool(key, url, model) {
  const { response, text } = await callChat(key, url, {
    model,
    messages: [{
      role: "user",
      content: "Call the codex_router_probe tool exactly once with value=ok. Do not answer normally.",
    }],
    tools: [TOOL],
    tool_choice: "required",
    stream: false,
  });
  const toolCall = parseJson(text)?.choices?.[0]?.message?.tool_calls?.[0];
  let argumentsValid = false;
  try {
    argumentsValid = JSON.parse(toolCall?.function?.arguments || "{}").value === "ok";
  } catch {
    // Invalid tool arguments are a compatibility failure.
  }
  const valid = toolCall?.function?.name === TOOL.function.name && argumentsValid;
  return {
    ok: response.ok && valid,
    status: response.status,
    detail: response.ok ? (valid ? "tool call and arguments verified" : "tool call missing or invalid") : httpDetail(response.status),
  };
}

async function statelessToolResult(key, url, model) {
  const { response, text } = await callChat(key, url, {
    model,
    messages: [
      { role: "user", content: "What is the value? Call codex_router_probe with value=42." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_cert",
          type: "function",
          function: { name: TOOL.function.name, arguments: "{\"value\":\"42\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call_cert", content: "acknowledged" },
    ],
    tools: [TOOL],
    stream: false,
  });
  const body = parseJson(text)?.choices?.[0]?.message?.content;
  const hasResponse = typeof body === "string" && body.length > 0;
  return {
    ok: response.ok && hasResponse,
    status: response.status,
    detail: response.ok ? (hasResponse ? "tool-result-backed response verified" : "response content missing") : httpDetail(response.status),
  };
}

async function compact(key, url, model) {
  // Ollama Cloud exposes no separate compaction endpoint. This checks the
  // summary prompt used by the router; routed `/responses/compact` remains the
  // authority for the router's compaction transformation itself.
  const { response, text } = await callChat(key, url, {
    model,
    messages: [{
      role: "user",
      content: "Compact the following into one short sentence: the probe value is 42, and the user requested streaming and tool certifications.",
    }],
    stream: false,
  });
  const body = parseJson(text)?.choices?.[0]?.message?.content;
  const hasResponse = typeof body === "string" && body.length > 0;
  return {
    ok: response.ok && hasResponse,
    status: response.status,
    detail: response.ok ? (hasResponse ? "summary prompt response verified" : "response content missing") : httpDetail(response.status),
  };
}

export async function certifyModel(key, url, target) {
  const checks = [
    ["basic response", () => basic(key, url, target.upstreamModel)],
    ["streaming", () => streaming(key, url, target.upstreamModel)],
    ["forced tool", () => forcedTool(key, url, target.upstreamModel)],
    ["stateless tool result", () => statelessToolResult(key, url, target.upstreamModel)],
    ["compact", () => compact(key, url, target.upstreamModel)],
  ];
  const results = [];
  for (const [name, operation] of checks) results.push(await runCheck(name, operation));
  return {
    model: target.slug,
    ok: results.every((result) => result.ok),
    results,
  };
}

function usage() {
  return "Usage: node scripts/certify-ollama-cloud-direct.mjs MODEL [MODEL...] --live --yes";
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    process.stdout.write(`${usage()}\n\nRuns billed direct checks against the configured Ollama Cloud endpoint.\n`);
    return 0;
  }
  if (!argv.includes("--live") || !argv.includes("--yes")) {
    console.error("Live certification may use provider quota; pass --live --yes to confirm.");
    return 2;
  }
  const requested = argv.filter((value) => !value.startsWith("--"));
  if (requested.length === 0) {
    console.error(usage());
    return 2;
  }

  let key;
  let url;
  try {
    key = loadCredential();
    url = baseUrl();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Certification configuration unavailable.");
    return 1;
  }

  const results = [];
  for (const value of requested) {
    let target;
    try {
      target = resolveTargetModel(value);
    } catch {
      console.error("Unknown Ollama Cloud model; pass a registered slug or upstream model id.");
      return 2;
    }
    results.push(await certifyModel(key, url, target));
  }
  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  return results.every((result) => result.ok) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    if (code) process.exitCode = code;
  }).catch(() => {
    // Keep unexpected filesystem and transport details out of terminal output.
    console.error("Certification failed.");
    process.exitCode = 1;
  });
}

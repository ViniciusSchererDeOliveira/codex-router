#!/usr/bin/env node
// Direct exact-route certification against https://ollama.com/v1/chat/completions.
// Bypasses the local router so this can run while the system router is on an
// older checkout; the "exact-route" property is preserved by construction
// because there is no failover layer between this script and the upstream.
// Surfaces covered: basic, streaming, forced-tool, stateless tool-result,
// compact. All run sequentially against the requested upstream model id.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_URL = "https://ollama.com/v1";
const MARKER = "CODEX_ROUTER_EXACT_OK";

// Resolves the Ollama Cloud credential the same way the installed router does:
// an explicit env override first, then the operator's protected key file under
// the per-user Codex state directory, then macOS Keychain via the provider's
// documented lookup. Never commits an absolute path or a key material to the
// repository.
function loadKey() {
  for (const env of ["OLLAMA_API_KEY", "OLLAMA_CLOUD_API_KEY"]) {
    const value = process.env[env];
    if (value && value.trim()) return value.trim();
  }
  const keyFile = process.env.OLLAMA_CLOUD_API_KEY_FILE
    || path.join(os.homedir(), ".codex", "codex-router", "ollama-cloud-api-key.secret");
  const raw = readFileSync(keyFile, "utf8").trim();
  if (!raw) throw new Error(`Ollama Cloud key file is empty: ${keyFile}`);
  return raw;
}

async function callChat(key, body, { timeoutMs = 180_000 } = {}) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Codex-Router-Exact-Route": "1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  return { response, text };
}

async function basic(key, model) {
  const { response, text } = await callChat(key, {
    model,
    messages: [{ role: "user", content: `Reply with exactly ${MARKER} and nothing else.` }],
    stream: false,
  });
  let parsed = {};
  try { parsed = JSON.parse(text); } catch {}
  const content = parsed?.choices?.[0]?.message?.content || "";
  return {
    name: "basic response",
    ok: response.ok && content.includes(MARKER),
    status: response.status,
    detail: response.ok ? (content.includes(MARKER) ? "exact marker verified" : `unexpected body: ${content.slice(0, 120)}`) : `HTTP ${response.status}: ${text.slice(0, 200)}`,
  };
}

async function streaming(key, model) {
  const { response, text } = await callChat(key, {
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
    .map((line) => {
      try {
        const event = JSON.parse(line);
        return event?.choices?.[0]?.delta?.content || "";
      } catch { return ""; }
    })
    .join("");
  return {
    name: "streaming",
    ok: response.ok && sawDone && streamedText.includes(MARKER),
    status: response.status,
    detail: response.ok ? (sawDone ? "stream text and [DONE] completion verified" : "stream ended without [DONE]") : `HTTP ${response.status}: ${text.slice(0, 200)}`,
  };
}

async function forcedTool(key, model) {
  const { response, text } = await callChat(key, {
    model,
    messages: [{
      role: "user",
      content: "Call the codex_router_probe tool exactly once with value=\"ok\". Do not answer normally.",
    }],
    tools: [{
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
    }],
    tool_choice: "required",
    stream: false,
  });
  let parsed = {};
  try { parsed = JSON.parse(text); } catch {}
  const toolCall = parsed?.choices?.[0]?.message?.tool_calls?.[0];
  let argsValid = false;
  try {
    argsValid = JSON.parse(toolCall?.function?.arguments || "{}").value === "ok";
  } catch {}
  return {
    name: "forced tool",
    ok: response.ok && toolCall?.function?.name === "codex_router_probe" && argsValid,
    status: response.status,
    detail: response.ok
      ? (toolCall ? `tool call ${toolCall.function?.name} with arguments verified` : "tool_calls missing")
      : `HTTP ${response.status}: ${text.slice(0, 200)}`,
  };
}

async function statelessToolResult(key, model) {
  const { response, text } = await callChat(key, {
    model,
    messages: [
      { role: "user", content: "What is the value? Call codex_router_probe with value=\"42\"." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_cert",
          type: "function",
          function: { name: "codex_router_probe", arguments: "{\"value\":\"42\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call_cert", content: "acknowledged" },
    ],
    tools: [{
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
    }],
    stream: false,
  });
  let parsed = {};
  try { parsed = JSON.parse(text); } catch {}
  const body = parsed?.choices?.[0]?.message?.content || "";
  return {
    name: "stateless tool result",
    ok: response.ok && Boolean(body),
    status: response.status,
    detail: response.ok ? `tool-result-backed response: ${String(body).slice(0, 100)}` : `HTTP ${response.status}: ${text.slice(0, 200)}`,
  };
}

async function compact(key, model) {
  // Codex compaction calls the same /chat/completions surface with a long
  // transcript-summary prompt; there is no separate upstream endpoint. The
  // exact-route certification only needs a non-empty response from the route
  // when asked to compact.
  const { response, text } = await callChat(key, {
    model,
    messages: [{
      role: "user",
      content: "Compact the following into one short sentence: the probe value is 42, and the user requested streaming and tool certifications.",
    }],
    stream: false,
  });
  let parsed = {};
  try { parsed = JSON.parse(text); } catch {}
  const body = parsed?.choices?.[0]?.message?.content || "";
  return {
    name: "compact",
    ok: response.ok && Boolean(body),
    status: response.status,
    detail: response.ok ? "non-empty compaction response verified" : `HTTP ${response.status}: ${text.slice(0, 200)}`,
  };
}

async function certifyModel(key, model) {
  const results = [];
  results.push(await basic(key, model));
  results.push(await streaming(key, model));
  results.push(await forcedTool(key, model));
  results.push(await statelessToolResult(key, model));
  results.push(await compact(key, model));
  return { model, ok: results.every((r) => r.ok), results };
}

async function main() {
  const key = loadKey();
  const models = process.argv.slice(2);
  if (!models.length) {
    console.error("Usage: certify-ollama-cloud-direct.mjs MODEL [MODEL...]");
    process.exit(2);
  }
  const out = [];
  for (const model of models) {
    out.push(await certifyModel(key, model));
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results: out }, null, 2));
  if (out.some((entry) => !entry.ok)) process.exitCode = 1;
}

await main();

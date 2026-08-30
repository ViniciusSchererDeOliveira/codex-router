import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { EXACT_ROUTE_PROBE_HEADER } from "../src/exact-route-probe.mjs";
import { compatibilityTest } from "../src/compatibility-test.mjs";

function jsonResponse(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function bodyJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startCompatibilityServer() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await bodyJson(request);
    requests.push({ path: request.url, headers: request.headers, body });
    if (request.url.endsWith("/responses/compact")) {
      jsonResponse(response, {
        output: [{ type: "message", content: [{ type: "output_text", text: "compacted" }] }],
      });
      return;
    }
    if (body.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end([
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "CODEX_ROUTER_STREAM_OK" })}`,
        "",
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp-stream" } })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"));
      return;
    }
    if (body.tool_choice === "required") {
      jsonResponse(response, {
        output: [{
          type: "function_call",
          name: "codex_router_probe",
          call_id: "call-probe",
          arguments: "{\"value\":\"ok\"}",
        }],
      });
      return;
    }
    if (Array.isArray(body.input)) {
      jsonResponse(response, {
        output: [{ type: "message", content: [{ type: "output_text", text: "42 acknowledged" }] }],
      });
      return;
    }
    jsonResponse(response, {
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "CODEX_ROUTER_SMOKE_OK" }],
      }],
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("routed compatibility certification covers all five exact-route surfaces", async () => {
  const mock = await startCompatibilityServer();
  const previousBaseUrl = process.env.CODEX_ROUTER_BASE_URL;
  process.env.CODEX_ROUTER_BASE_URL = mock.url;
  try {
    const result = await compatibilityTest("ollama-cloud/glm-5.3", {
      reasoningEffort: "medium",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results.map((entry) => entry.name), [
      "basic response",
      "streaming",
      "tool calling",
      "stateless tool result",
      "compaction",
    ]);
    assert.equal(mock.requests.length, 5);
    assert.equal(
      mock.requests.every((entry) => entry.headers[EXACT_ROUTE_PROBE_HEADER] === "1"),
      true,
    );
    assert.deepEqual(mock.requests.map((entry) => entry.path), [
      "/responses",
      "/responses",
      "/responses",
      "/responses",
      "/responses/compact",
    ]);
    for (const entry of mock.requests.slice(0, 4)) {
      assert.equal(entry.body.model, "ollama-cloud/glm-5.3");
      assert.equal(entry.body.reasoning.effort, "medium");
      assert.equal(entry.body.reasoning_effort, "medium");
    }
    assert.deepEqual(
      mock.requests[3].body.input.map((item) => item.type),
      ["message", "function_call", "function_call_output"],
    );
  } finally {
    if (previousBaseUrl === undefined) delete process.env.CODEX_ROUTER_BASE_URL;
    else process.env.CODEX_ROUTER_BASE_URL = previousBaseUrl;
    await mock.close();
  }
});

test("compatibility certification refuses an unknown effort before spending quota", async () => {
  await assert.rejects(
    compatibilityTest("ollama-cloud/glm-5.3", { reasoningEffort: "extreme" }),
    /Unknown reasoning effort/,
  );
});

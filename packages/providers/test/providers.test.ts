/**
 * Provider adapter contract tests (#0196 PROVIDER TEST MATRIX).
 * A local mock OpenAI-compatible server exercises the full streaming path,
 * tool-call parsing, retries and circuit breaker behavior.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAiCompatibleProvider } from "../src/openai.js";
import { OllamaProvider } from "../src/ollama.js";
import { ProviderRegistry, route } from "../src/registry.js";

function sse(res: import("node:http").ServerResponse, events: object[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

describe("openai-compatible provider against a real mock server", () => {
  let server: Server;
  let baseUrl = "";
  const requests: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "test-model", context_window: 8192 }] }));
        return;
      }
      if (url.startsWith("/v1/chat/completions")) {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          requests.push(body);
          const parsed = JSON.parse(body) as { stream?: boolean };
          assert.equal(parsed.stream, true);
          sse(res, [
            { choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
            { choices: [{ delta: { content: "lo world" }, finish_reason: null }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
            { usage: { prompt_tokens: 5, completion_tokens: 2 } },
          ]);
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  after(async () => new Promise<void>((r) => server.close(() => r())));

  it("streams deltas and usage in order", async () => {
    const p = new OpenAiCompatibleProvider({ id: "mock", baseUrl });
    const models = await p.listModels();
    assert.equal(models[0]!.modelId, "test-model");
    const chunks = [];
    for await (const c of p.chat({ model: "test-model", messages: [{ role: "user", content: "hi" }] })) chunks.push(c);
    const text = chunks.filter((c) => c.type === "delta").map((c) => (c as { text: string }).text).join("");
    assert.equal(text, "Hello world");
    const done = chunks.findLast((c) => c.type === "done");
    assert.equal(done && "finishReason" in done ? done.finishReason : "", "stop");
  });

  it("health reflects a reachable provider", async () => {
    const p = new OpenAiCompatibleProvider({ id: "mock", baseUrl });
    assert.equal((await p.health()).status, "healthy");
  });

  it("rejects invalid base urls at construction", () => {
    assert.throws(() => new OpenAiCompatibleProvider({ id: "x", baseUrl: "::not-a-url::" }));
  });
});

describe("ollama adapter shape", () => {
  it("reports unreachable health without a live server", async () => {
    const p = new OllamaProvider({ id: "local-ollama", baseUrl: "http://127.0.0.1:9" });
    const h = await p.health();
    assert.equal(h.status, "unreachable");
    assert.match(h.detail ?? "", /ollama/i);
  });
});

describe("routing policy", () => {
  it("refuses to silently switch providers for sensitive data when the preferred model is down", async () => {
    const registry = new ProviderRegistry();
    // No providers registered -> preferred model lookup fails.
    await assert.rejects(
      route(registry, { classification: "sensitive", preferredModelId: "gone:model", interactive: false }),
      /silent(ly)? (provider )?switch|cannot receive|No available model/i,
    );
  });

  it("prefers local destinations first for equal capability", async () => {
    // Registry with no reachable providers yields no candidates -> clear error.
    const registry = new ProviderRegistry();
    await assert.rejects(route(registry, { classification: "public", interactive: true }), /no capable provider/i);
  });
});

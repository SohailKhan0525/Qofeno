/**
 * Server composition: wires the engine graph into HTTP routes + serves the
 * web app. `qofeno serve` runs this.
 */
import { QofenoServer } from "./http.js";
import { buildBundle } from "@agent-qofeno/qofeno-cli";
import { newId, ID } from "@agent-qofeno/core";

export async function startServer(opts: { port?: number; apiToken?: string; staticDir?: string; homeOverride?: string }): Promise<{ port: number }> {
  const bundle = await buildBundle({ homeOverride: opts.homeOverride });
  const server = new QofenoServer({
    port: opts.port ?? 7_931,
    apiToken: opts.apiToken,
    staticDir: opts.staticDir,
  });

  const ok = (res: import("node:http").ServerResponse, data: unknown): void => {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(data));
  };

  server.route("GET", "/api/models", async (_q, res) => {
    ok(res, { models: await bundle.providers.allModels() });
  });

  server.route("GET", "/api/sessions", async (_q, res) => {
    ok(res, { sessions: await bundle.sessions.list({ limit: 50 }) });
  });

  server.route("POST", "/api/sessions", async (_q, res, _p, body) => {
    const b = (body ?? {}) as { title?: string };
    const s = await bundle.sessions.create({ title: (b.title ?? "New session").slice(0, 120) });
    ok(res, { session: s });
  });

  server.route("GET", "/api/sessions/:id/messages", async (_q, res, p) => {
    ok(res, { messages: await bundle.sessions.listMessages(String(p.id)) });
  });

  server.route("POST", "/api/sessions/:id/messages", async (_q, res, p, body) => {
    const b = (body ?? {}) as { content?: string };
    if (!b.content?.trim()) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "content required" }));
      return;
    }
    const msg = await bundle.sessions.appendMessage(String(p.id), { role: "user", content: b.content.slice(0, 100_000), status: "completed" });
    ok(res, { message: msg });
  });

  server.route("POST", "/api/chat", async (_q, res, _p, body) => {
    const b = (body ?? {}) as { prompt?: string; modelId?: string };
    if (!b.prompt) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "prompt required" }));
      return;
    }
    try {
      const routed = await (await import("@agent-qofeno/providers")).route(bundle.providers, {
        classification: bundle.config.merged.security?.localOnly ? "local-only" : "private",
        preferredModelId: b.modelId ?? bundle.config.merged.model,
        interactive: false,
      });
      const { provider, model } = await bundle.providers.findModel(`${routed.providerId}:${routed.modelId}`);
      let text = "";
      for await (const chunk of provider.chat({
        model: model.modelId,
        messages: [{ role: "user", content: b.prompt.slice(0, 50_000) }],
      })) {
        if (chunk.type === "delta") text += chunk.text;
        if (chunk.type === "error") throw new Error(chunk.message);
      }
      ok(res, { result: text, model: `${routed.providerId}:${routed.modelId}` });
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String((e as Error).message ?? e).slice(0, 300) }));
    }
  });

  server.route("GET", "/api/memory", async (_q, res) => {
    ok(res, { memories: await bundle.memory.relevant(undefined) });
  });

  server.route("POST", "/api/memory", async (_q, res, _p, body) => {
    const b = (body ?? {}) as { content?: string };
    if (!b.content?.trim()) {
      res.writeHead(400).end();
      return;
    }
    const m = await bundle.memory.add({ content: b.content, scope: "global", provenance: "user" });
    ok(res, { memory: m });
  });

  server.route("DELETE", "/api/memory/:id", async (_q, res, p) => {
    await bundle.memory.delete(String(p.id));
    ok(res, { deleted: true });
  });

  server.route("POST", "/api/tools/:name", async (_q, res, p, body) => {
    // Tools over HTTP run non-interactive and fail closed without grants.
    const result = await bundle.tools.invoke(
      String(p.name),
      body ?? {},
      {
        projectRoot: process.cwd(),
        interactive: false,
        workspaceTrusted: false,
        classification: "private",
        grants: [],
        denies: [],
        policyRules: [],
        audit: () => {},
        confirm: async () => false,
      },
    );
    res.writeHead(result.ok ? 200 : 403, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  });

  server.route("GET", "/api/events", async (_q, res) => {
    ok(res, { events: await bundle.store.listAudit(50) });
  });

  // ---- Knowledge & agents routes used by the Qofeno App -------------------

  server.route("POST", "/api/knowledge/collections", async (_q, res, _p, body) => {
    const b = (body ?? {}) as { name?: string };
    const col = await bundle.knowledge.ensureCollection((b.name ?? "project").slice(0, 80));
    ok(res, { collection: col });
  });

  server.route("POST", "/api/knowledge/collections/:id/documents", async (_q, res, p, body) => {
    const b = (body ?? {}) as { title?: string; content?: string };
    if (!b.content?.trim()) {
      res.writeHead(400).end(JSON.stringify({ error: "content required" }));
      return;
    }
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(b.content).digest("hex");
    const src = await bundle.knowledge.indexDocument(String(p.id), { kind: "text", title: (b.title ?? "document").slice(0, 200), content: b.content }, sha);
    ok(res, { ok: src.indexState === "indexed", output: `${src.title}: ${src.indexState}, ${src.chunkCount} chunks` });
  });

  server.route("GET", "/api/knowledge/search", async (_q, res, _p, _b) => {
    const q = new URL(_q.url ?? "/", "http://x").searchParams.get("q") ?? "";
    const cols = await bundle.store.listCollections(undefined);
    const results = await bundle.knowledge.retrieve(cols.map((c) => c.id), q.slice(0, 500), 8);
    ok(res, { results });
  });

  server.route("POST", "/api/agents/run", async (_q, res, _p, body) => {
    const b = (body ?? {}) as { goal?: string; modelId?: string };
    if (!b.goal || !b.modelId?.includes(":")) {
      res.writeHead(400).end(JSON.stringify({ error: "goal and modelId required" }));
      return;
    }
    try {
      const { AgentRuntime } = await import("@agent-qofeno/agents");
      const routed = await (await import("@agent-qofeno/providers")).route(bundle.providers, {
        classification: bundle.config.merged.security?.localOnly ? "local-only" : "private",
        preferredModelId: b.modelId,
        interactive: false,
      });
      const { provider } = await bundle.providers.findModel(`${routed.providerId}:${routed.modelId}`);
      const agent = new AgentRuntime(provider, bundle.tools, bundle.context);
      const result = await agent.run(
        { goal: b.goal.slice(0, 2_000), modelId: `${routed.providerId}:${routed.modelId}`, interactive: false },
        {
          projectRoot: process.cwd(),
          interactive: false,
          workspaceTrusted: false,
          classification: "private",
          grants: [],
          denies: [],
          policyRules: [],
          audit: () => {},
          confirm: async () => false,
        },
      );
      ok(res, result);
    } catch (e) {
      res.writeHead(502).end(JSON.stringify({ error: String((e as Error).message ?? e).slice(0, 300) }));
    }
  });

  server.route("POST", "/api/jobs/_noop", async (_q, res) => {
    // Reserved job endpoint; jobs are executed in-process by the CLI today.
    ok(res, { id: newId(ID.job), status: "noop" });
  });

  await server.listen();
  return { port: opts.port ?? 7_931 };
}

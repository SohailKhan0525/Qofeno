/**
 * Server composition: wires the engine graph into HTTP routes + serves the
 * web app. `qofeno serve` runs this.
 */
import { QofenoServer } from "./http.js";
import { buildBundle } from "@agent-qofeno/cli";
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

  server.route("POST", "/api/jobs/_noop", async (_q, res) => {
    // Reserved job endpoint; jobs are executed in-process by the CLI today.
    ok(res, { id: newId(ID.job), status: "noop" });
  });

  await server.listen();
  return { port: opts.port ?? 7_931 };
}

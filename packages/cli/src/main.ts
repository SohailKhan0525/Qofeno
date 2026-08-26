#!/usr/bin/env node
/**
 * qofeno main entrypoint (#CLI IDENTITY / #0108 exit code contract).
 */
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  QofenoError,
  isQofenoError,
  newId,
  ID,
  type PermissionGrant,
  type DenyRule,
} from "@agent-qofeno/core";
import { Stylizer, pickTheme, ActivityIndicator, renderMarkdown, computeDiff, renderDiff } from "@agent-qofeno/term";
import { LineEditor } from "@agent-qofeno/input";
import { detectSecretStore, redactSecrets } from "@agent-qofeno/security";
import { elevatedWarning } from "@agent-qofeno/runtime";
import { QofenoRepl, DenyAllPrompter, type PermissionPrompter } from "@agent-qofeno/repl";
import { AgentRuntime } from "@agent-qofeno/agents";
import { WorkflowEngine } from "@agent-qofeno/workflows";
import { ExtensionHost } from "@agent-qofeno/ext";
import { buildBundle, type Bundle } from "@agent-qofeno/bundle";
import { parseArgs, USAGE, outputFormatOf } from "./args.js";

const VERSION = "0.1.0";

function out(s: string): void {
  process.stdout.write(s + "\n");
}

function errOut(s: string): void {
  process.stderr.write(s + "\n");
}

interface HeadlessResult {
  result: string;
  sessionId?: string;
  status?: string;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const format = outputFormatOf(args);

  if (args.flags.help || args.flags.h) {
    out(USAGE);
    return 0;
  }
  if (args.flags.version) {
    out(VERSION);
    return 0;
  }

  const command = args.positional[0];
  const bundle = await buildBundle({
    projectRoot: typeof args.flags["project-root"] === "string" ? resolve(String(args.flags["project-root"])) : undefined,
    profile: typeof args.flags.profile === "string" ? args.flags.profile : undefined,
    modelOverride: typeof args.flags.model === "string" ? String(args.flags.model) : typeof args.flags.m === "string" ? String(args.flags.m) : undefined,
  });

  try {
    if (command === undefined || command === "interactive") {
      return await runInteractive(bundle, args, format);
    }
    if (command !== undefined && !command.startsWith("-")) {
      // -p may come after the subcommand-less invocation only; treat explicit
      // management commands first.
      return await runManagementCommand(command, bundle, args);
    }
    errOut(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof QofenoError && e.code === "cancelled") return 130;
    const msg = e instanceof Error ? e.message : String(e);
    if (format === "text") errOut(`error: ${redactSecrets(msg)}`);
    else errOut(JSON.stringify({ error: redactSecrets(msg) }));
    return e instanceof QofenoError ? e.exitCode : 1;
  } finally {
    await bundle.store.close().catch(() => {});
  }
}

// ---- Interactive ---------------------------------------------------------------

async function runInteractive(bundle: Bundle, args: ReturnType<typeof parseArgs>, _format: string): Promise<number> {
  void _format;
  const caps = bundle.capabilities;
  const theme = pickTheme(bundle.config.merged.theme ?? (caps.colorDepth === 24 ? "dark" : "dark"));
  const st = new Stylizer({ theme, colorEnabled: caps.colorEnabled, unicode: caps.unicode });
  const projectRoot = resolve(typeof args.flags["project-root"] === "string" ? String(args.flags["project-root"]) : process.cwd());

  out(st.primary(`qofeno v${VERSION}`));
  out(st.muted(`project ${projectRoot} · trust=${bundle.trust.status(projectRoot)} · mode=execute`));
  const elevate = elevatedWarning();
  if (elevate) out(st.warning(elevate));

  const models = await bundle.providers.allModels();
  if (models.length === 0) {
    out(st.warning("No AI providers reachable yet. Start Ollama (`ollama serve`) or run `qofeno provider add openai`."));
  }

  const repl = new QofenoRepl({
    store: bundle.store,
    sessions: bundle.sessions,
    memory: bundle.memory,
    knowledge: bundle.knowledge,
    context: bundle.context,
    tools: bundle.tools,
    providers: bundle.providers,
    config: bundle.config,
    projectRoot,
    workspaceTrusted: bundle.trust.status(projectRoot) !== "untrusted",
    prompter: terminalPrompter(st),
    render: {
      assistantChunk: (t) => {
        if (!pendingToolActivity) process.stdout.write(t);
      },
      assistantDone: (full) => {
        if (full.trim()) {
          process.stdout.write("\n");
          for (const line of renderMarkdown(full, st, caps.columns)) process.stdout.write(line + "\n");
        }
      },
      activity: (line) => {
        pendingToolActivity = true;
        process.stdout.write("\r\u001b[2K" + st.muted(line) + "\n");
        pendingToolActivity = false;
      },
      error: (m) => out(st.error("✗ " + m)),
      info: (m) => out(st.muted(m)),
    },
  });

  let pendingToolActivity = false;

  if (typeof args.flags.resume === "string") {
    repl.sessionId = String(args.flags.resume);
    out(st.muted(`resumed session ${repl.sessionId}`));
  } else if (args.flags.c) {
    const recent = await bundle.sessions.list({ limit: 1 });
    if (recent[0]) {
      repl.sessionId = recent[0].id;
      out(st.muted(`continuing: ${recent[0].title} (${repl.sessionId})`));
    }
  }

  if (typeof args.flags.mode === "string") repl.setMode(String(args.flags.mode) as never);

  // Raw-mode editor when TTY; readline fallback otherwise (SSH/dumb safe).
  if (!caps.isTTY || caps.dumb || caps.ciEnvironment) {
    const rl = createInterface({ input: process.stdin, terminal: false });
    out(st.muted("non-interactive stdin detected — reading one prompt from stdin (-p style)"));
    let piped = "";
    for await (const line of rl) piped += line + "\n";
    await repl.handleInput(piped.trim());
    return 0;
  }

  const editor = new LineEditor({
    onSubmit: () => {},
    onInterrupt: () => {},
    render: (s) => {
      // Minimal inline echo; full redraw handled by readline below.
      void s;
    },
    completions: {
      complete(input) {
        if (input.startsWith("/")) {
          return ["/help", "/model", "/mode", "/memory", "/knowledge", "/compact", "/sessions", "/resume", "/export", "/tools", "/privacy", "/clear", "/quit"]
            .filter((c) => c.startsWith(input))
            .map((c) => ({ label: c, insert: c + " " }));
        }
        return [];
      },
    },
  });

  const historyFile = join(bundle.paths.cache, "history.txt");
  try {
    if (existsSync(historyFile)) {
      const { readFileSync } = await import("node:fs");
      editor.loadHistory(readFileSync(historyFile, "utf8").split("\n").filter(Boolean).slice(-500));
    }
  } catch {
    /* history is best-effort */
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: st.accent("› "),
    completer: (line: string) => {
      const options = ["/help", "/model", "/mode", "/memory", "/knowledge", "/compact", "/sessions", "/resume", "/export", "/tools", "/privacy", "/clear", "/quit"].filter((c) =>
        c.startsWith(line),
      );
      return [options.length ? options : [], line];
    },
  });
  void editor;

  rl.prompt();
  for await (const line of rl) {
    try {
      const { handled, output } = await repl.handleInput(line);
      if (handled && output) out(output);
    } catch (e) {
      if (e instanceof QofenoError && e.code === "cancelled") break;
      out(st.error(redactSecrets(e instanceof Error ? e.message : String(e))));
    }
    rl.prompt();
  }
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(historyFile, "");
  } catch {
    /* ignore */
  }
  out(st.muted("bye"));
  return 0;
}

function terminalPrompter(st: Stylizer): PermissionPrompter {
  return {
    async ask(req) {
      out("");
      out(st.warning(`⏸  ${req.title}`));
      if (req.detail) for (const l of req.detail.split("\n").slice(0, 12)) out(st.muted(`   ${l}`));
      const answer = await new Promise<string>((resolveP) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        out(st.muted("   [y] once  [s] this session  [p] this project  [a] pattern…  [n] deny  [N] deny & remember"));
        rl.question(st.accent("   choice> "), (ans) => {
          rl.close();
          resolveP(ans.trim().toLowerCase());
        });
      });
      switch (answer) {
        case "y":
          return "once";
        case "s":
          return "session";
        case "p":
          return "project";
        case "a":
          return "pattern";
        case "n":
          return "deny";
        case "N":
          return "deny-remember";
        default:
          return "cancel";
      }
    },
  };
}
void DenyAllPrompter;

// ---- Print / headless mode -----------------------------------------------------

async function runPrintMode(bundle: Bundle, prompt: string, args: ReturnType<typeof parseArgs>): Promise<HeadlessResult> {
  const spinner = new ActivityIndicator(new Stylizer({ theme: pickTheme(), colorEnabled: false, unicode: false }), {
    unicode: false,
    tty: false,
    reducedMotion: true,
  });
  void spinner;
  const outputs: Array<{ type: string; text?: string }> = [];
  const repl = new QofenoRepl({
    store: bundle.store,
    sessions: bundle.sessions,
    memory: bundle.memory,
    knowledge: bundle.knowledge,
    context: bundle.context,
    tools: bundle.tools,
    providers: bundle.providers,
    config: bundle.config,
    projectRoot: resolve(typeof args.flags["project-root"] === "string" ? String(args.flags["project-root"]) : process.cwd()),
    workspaceTrusted: false, // headless defaults to untrusted → stricter (#0132)
    prompter: new DenyAllPrompter(),
    render: {
      assistantChunk: (t) => outputs.push({ type: "delta", text: t }),
      assistantDone: (full) => outputs.push({ type: "done", text: full }),
      activity: (l) => outputs.push({ type: "activity", text: l }),
      error: (m) => outputs.push({ type: "error", text: m }),
      info: () => {},
    },
  });
  await repl.handleInput(prompt);
  const done = [...outputs].reverse().find((o) => o.type === "done");
  return { result: done?.text ?? "", ...(repl.sessionId ? { sessionId: repl.sessionId } : {}), status: repl.mode };
}

// ---- Management commands ----------------------------------------------------------

async function runManagementCommand(command: string, bundle: Bundle, args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positional[1];
  switch (command) {
    case "version":
      out(VERSION);
      return 0;
    case "doctor": {
      const h = await bundle.store.healthCheck();
      const lines = [
        `platform:        ${bundle.capabilities.platform}`,
        `tty/color:       ${bundle.capabilities.isTTY}/${bundle.capabilities.colorDepth}-bit`,
        `ci/tmux/ssh:     ${bundle.capabilities.ciEnvironment}/${bundle.capabilities.tmux}/${bundle.capabilities.ssh}`,
        `data dir:        ${bundle.paths.root}`,
        `storage:         ${h.ok ? "ok" : `ERROR ${h.detail}`} (sqlite, WAL)`,
        `providers:       ${(await bundle.providers.allModels()).length} models visible`,
        `elevation:       ${process.getuid?.() === 0 ? "root (not recommended)" : "normal"}`,
        `telemetry:       ${bundle.config.merged.telemetryEnabled ? "enabled" : "disabled"}`,
      ];
      out(lines.join("\n"));
      return h.ok ? 0 : 22;
    }
    case "privacy": {
      const secrets = detectSecretStore(bundle.paths.credentials);
      out(
        [
          `Data lives in:   ${bundle.paths.root}`,
          `  sessions:      ${bundle.paths.root}/qofeno.db`,
          `  credentials:   ${secrets.backend}`,
          `Providers configured:`,
          ...(bundle.config.merged.providers ?? []).map((p) => `  ${p.kind}:${p.id} → ${p.baseUrl ?? "(default)"}`),
          `Network posture: ${bundle.config.merged.security?.localOnly ? "LOCAL-ONLY (no hosted calls)" : "hosted calls allowed with your consent per tool"}`,
          `Telemetry:       none by default`,
        ].join("\n"),
      );
      return 0;
    }
    case "sessions": {
      if (sub === "list") {
        const list = await bundle.sessions.list({ includeArchived: true, limit: 30 });
        out(list.length ? list.map((s) => `${s.id}  ${s.archivedAtMs ? "[archived] " : ""}${s.title}`).join("\n") : "(none)");
        return 0;
      }
      if (sub === "rm" && args.positional[2]) {
        await bundle.sessions.softDelete(args.positional[2]);
        out("deleted");
        return 0;
      }
      if (sub === "export" && args.positional[2]) {
        const json = await bundle.sessions.exportSession(args.positional[2]);
        const path = args.positional[3] ?? `session-${String(args.positional[2])}.json`;
        await writeFile(path, json, { mode: 0o600 });
        out(`exported → ${path}`);
        return 0;
      }
      errOut("usage: qofeno sessions list|rm <id>|export <id> [path]");
      return 2;
    }
    case "permissions": {
      const grants: PermissionGrant[] = await bundle.store.listGrants();
      const denies: DenyRule[] = await bundle.store.listDenies();
      if (sub === "grant") {
        // permissions grant <permission> [pattern]
        const permission = args.positional[2] as PermissionGrant["permission"];
        const pattern = args.positional[3];
        const g: PermissionGrant = { id: newId(ID.grant), permission, scope: pattern ? { kind: "pattern", pattern } : { kind: "always" }, decision: "allow-session", source: "cli-flag", createdAtMs: Date.now() };
        await bundle.store.addGrant(g);
        out(`granted ${permission}${pattern ? ` pattern=${pattern}` : ""} (${g.id})`);
        return 0;
      }
      if (sub === "deny") {
        const d: DenyRule = { id: newId(ID.grant), permission: args.positional[2] as DenyRule["permission"], pattern: args.positional[3], source: "cli-flag", createdAtMs: Date.now() };
        await bundle.store.addDeny(d);
        out("denied rule added");
        return 0;
      }
      if (sub === "revoke" && args.positional[2]) {
        await bundle.store.revokeGrant(args.positional[2]);
        out("revoked");
        return 0;
      }
      out(["GRANTS:", ...grants.map((g) => `  ${g.id}  ${g.permission}  ${JSON.stringify(g.scope)}`), "DENIES:", ...denies.map((d) => `  ${d.id}  ${d.permission}  ${d.pattern ?? "*"}`)].join("\n"));
      return 0;
    }
    case "provider": {
      if (sub === "add") {
        const kind = args.positional[2];
        const baseUrl = args.positional[3];
        const providersCfg = bundle.config.merged.providers ?? [];
        const id = `${kind}-${providersCfg.length + 1}`;
        providersCfg.push({ id, kind: kind as "openai" | "ollama" | "anthropic", baseUrl });
        const userConfigPath = join(bundle.paths.config, "user.json");
        const current = existsSync(userConfigPath) ? JSON.parse(await readFile(userConfigPath, "utf8")) : {};
        current.providers = providersCfg;
        await writeFile(userConfigPath, JSON.stringify(current, null, 2), { mode: 0o600 });
        if (kind === "openai") {
          const secrets = detectSecretStore(bundle.paths.credentials);
          out(`Set the API key (input hidden, stored in ${secrets.backend}):`);
          const key = await readHiddenKey();
          await secrets.set(`provider:${id}`, key);
          const updated = JSON.parse(await readFile(userConfigPath, "utf8"));
          updated.providers = updated.providers.map((p: { id: string; credentialRef?: string }) => (p.id === id ? { ...p, credentialRef: `provider:${id}` } : p));
          await writeFile(userConfigPath, JSON.stringify(updated, null, 2), { mode: 0o600 });
        }
        out(`Provider ${id} saved. Restart qofeno to use it.`);
        return 0;
      }
      if (sub === "test") {
        const models = await bundle.providers.allModels();
        out(models.map((m) => `${m.id} (${m.destination})`).join("\n") || "no providers reachable");
        return 0;
      }
      out((bundle.config.merged.providers ?? []).map((p) => `${p.kind}:${p.id} ${p.baseUrl ?? ""}`).join("\n") || "(none configured)");
      return 0;
    }
    case "memory": {
      if (sub === "add") {
        const text = args.positional.slice(2).join(" ");
        const m = await bundle.memory.add({ content: text, scope: "global", provenance: "user" });
        out(`saved ${m.id}`);
        return 0;
      }
      if (sub === "forget") {
        await bundle.memory.delete(String(args.positional[2] ?? ""));
        out("deleted");
        return 0;
      }
      if (sub === "clear") {
        const n = await bundle.memory.clearAll();
        out(`cleared ${n} memories`);
        return 0;
      }
      const list = await bundle.memory.relevant(undefined);
      out(list.length ? list.map((m) => `${m.id}  ${m.content.slice(0, 80)}`).join("\n") : "(empty)");
      return 0;
    }
    case "knowledge": {
      if (sub === "index" && args.positional[2]) {
        const file = resolve(args.positional[2]);
        const content = await readFile(file, "utf8");
        const col = await bundle.knowledge.ensureCollection("project", process.cwd());
        const { createHash } = await import("node:crypto");
        const sha = createHash("sha256").update(content).digest("hex");
        const src = await bundle.knowledge.indexDocument(col.id, { kind: "file", title: file, content }, sha);
        out(`${src.title}: ${src.indexState}, ${src.chunkCount} chunks`);
        return src.indexState === "indexed" ? 0 : 22;
      }
      if (sub === "search") {
        const cols = await bundle.store.listCollections(process.cwd());
        const hits = await bundle.knowledge.retrieve(cols.map((c) => c.id), args.positional.slice(2).join(" "), 6);
        out(hits.map((h) => `[${Math.round(h.score * 1000) / 1000}] ${h.sourceTitle}: ${h.chunk.text.slice(0, 100)}…`).join("\n") || "(no matches)");
        return 0;
      }
      errOut("usage: qofeno knowledge index <file>|search <query>");
      return 2;
    }
    case "tools":
      out(bundle.tools.list().map((t) => `${t.name.padEnd(14)} risk=${t.risk.padEnd(9)} perm=${t.requiredPermission ?? "-"}`).join("\n"));
      return 0;
    case "agents": {
      if (sub === "run") {
        const goal = args.positional.slice(2).join(" ") || String(args.flags.p ?? "");
        const modelId = String(args.flags.model ?? bundle.config.merged.model ?? "");
        if (!modelId.includes(":")) {
          errOut("set a model first: --model provider:model (see `qofeno provider test`)");
          return 2;
        }
        const routed = await import("@agent-qofeno/providers").then((m) =>
          m.route(bundle.providers, { classification: "private", preferredModelId: modelId, interactive: false }),
        );
        const { provider } = await bundle.providers.findModel(`${routed.providerId}:${routed.modelId}`);
        const agent = new AgentRuntime(provider, bundle.tools, bundle.context);
        const result = await agent.run(
          {
            goal,
            modelId: `${routed.providerId}:${routed.modelId}`,
            maxSteps: Number(args.flags["max-steps"] ?? bundle.config.merged.maxAgentSteps ?? 12),
            timeoutMs: Number(args.flags["timeout-ms"] ?? bundle.config.merged.agentTimeoutMs ?? 300_000),
            budgetUsd: bundle.config.merged.costBudgetUsd,
            allowedTools: typeof args.flags["allowed-tools"] === "string" ? String(args.flags["allowed-tools"]).split(",") : undefined,
          },
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
        out(`status=${result.status} steps=${result.steps.length} tools=${result.toolCalls} elapsed=${result.elapsedMs}ms`);
        out(result.answer || "(no answer)");
        return result.status === "completed" ? 0 : 1;
      }
      errOut("usage: qofeno agents run \"<goal>\" --model provider:model");
      return 2;
    }
    case "workflows": {
      if (sub === "validate" && args.positional[2]) {
        const engine = new WorkflowEngine(bundle.tools);
        const def = engine.validateImport(await readFile(String(args.positional[2]), "utf8"));
        out(`valid workflow: ${def.name} v${def.version} (${def.steps.length} steps, trigger=${def.trigger.kind})`);
        return 0;
      }
      errOut("usage: qofeno workflows validate <file.json>");
      return 2;
    }
    case "extensions": {
      const host = new ExtensionHost(bundle.paths.extensions);
      if (sub === "install" && args.positional[2]) {
        const rec = await host.installFromDirectory(resolve(args.positional[2]));
        out(`installed ${rec.manifest.id}@${rec.manifest.version} — disabled & untrusted by default`);
        out(`enable with: qofeno extensions enable ${rec.manifest.id}`);
        return 0;
      }
      if (sub === "enable" || sub === "disable") {
        const id = String(args.positional[2] ?? "");
        host.setEnabled(id, sub === "enable");
        out(`${id} ${sub}d`);
        return 0;
      }
      out(host.list().map((e) => `${e.manifest.id}@${e.manifest.version} enabled=${e.enabled} trusted=${e.trusted}`).join("\n") || "(none installed)");
      return 0;
    }
    case "diff": {
      // Utility: show a rendered diff of two files (terminal-first diff engine demo-free use)
      const a = await readFile(String(args.positional[1] ?? ""), "utf8").catch(() => "");
      const b = await readFile(String(args.positional[2] ?? ""), "utf8").catch(() => "");
      const st = new Stylizer({ theme: pickTheme(), colorEnabled: bundle.capabilities.colorEnabled, unicode: bundle.capabilities.unicode });
      for (const line of renderDiff(computeDiff(a, b), st, { maxWidth: bundle.capabilities.columns })) out(line);
      return 0;
    }
    case "serve": {
      const { startServer } = await import("@agent-qofeno/server");
      const { createRequire } = await import("node:module");
      const requireSrv = createRequire(import.meta.url);
      const srvPkgPath = requireSrv.resolve("@agent-qofeno/server/package.json");
      let webDir = join(srvPkgPath, "..", "..", "..", "apps", "app", "dist");
      if (!existsSync(join(webDir, "index.html"))) webDir = join(srvPkgPath, "..", "src", "web");
      const port = Number(args.flags.port ?? process.env.QOFENO_PORT ?? 7931);
      const token = typeof args.flags.token === "string" ? String(args.flags.token) : process.env.QOFENO_API_TOKEN;
      await startServer({ port, apiToken: token, staticDir: webDir });
      out(`qofeno server listening on http://127.0.0.1:${port}${token ? " (bearer auth)" : ""}`);
      return new Promise<number>(() => {
        // Serve until the process is terminated.
      });
    }
    case "config": {
      if (sub === "path") {
        out(join(bundle.paths.config, "user.json"));
        return 0;
      }
      if (sub === "get" && args.positional[2]) {
        const value = (bundle.config.merged as unknown as Record<string, unknown>)[args.positional[2]];
        out(value === undefined ? "(unset)" : JSON.stringify(value));
        return 0;
      }
      if (sub === "policy") {
        out(JSON.stringify(bundle.config.merged.security ?? {}, null, 2));
        return 0;
      }
      errOut("usage: qofeno config get <key>|path|policy");
      return 2;
    }
    default:
      // Not a known management command: treat as print-mode prompt.
      break;
  }
  // fallthrough → print mode
  return await runPrintFlow(bundle, args);
}

async function runPrintFlow(bundle: Bundle, args: ReturnType<typeof parseArgs>): Promise<number> {
  const promptSource =
    (typeof args.flags.p === "string" ? String(args.flags.p) : undefined) ??
    (typeof args.flags.print === "string" ? String(args.flags.print) : undefined) ??
    (args.positional.length ? args.positional.join(" ") : undefined);
  if (!promptSource) {
    errOut(USAGE);
    return 2;
  }
  const format = outputFormatOf(args);
  const res = await runPrintMode(bundle, promptSource, args);
  if (format === "json") out(JSON.stringify({ result: res.result, ...(res.sessionId ? { sessionId: res.sessionId } : {}) }));
  else if (format === "jsonl") {
    for (const line of res.result.split("\n")) out(JSON.stringify({ type: "text", text: line }));
  } else out(res.result);
  return 0;
}

async function readHiddenKey(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolveP) => {
    (rl as unknown as { question(q: string, cb: (a: string) => void, opts?: { silent?: boolean }): void }).question("", (ans) => {
      rl.close();
      out("");
      resolveP(ans.trim());
    }, { silent: true });
  });
}

process.on("SIGINT", () => process.exit(130));
main()
  .then((code) => process.exit(code))
  .catch((e) => {
    errOut(`fatal: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    process.exit(isQofenoError(e) ? e.exitCode : 1);
  });

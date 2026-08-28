#!/usr/bin/env node
/**
 * qofeno main entrypoint (#CLI IDENTITY / #0108 exit code contract).
 * Complete implementation of all OpenCode compatible CLI commands,
 * aliases, headless run flows, interactive TUI, and shell completion.
 */
import { createInterface } from "node:readline";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
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
import { COMMAND_MATRIX, SLASH_COMMANDS } from "./command-matrix.js";
import { generateCompletion } from "./completion.js";

const VERSION = (() => {
  try {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    return String((JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "0.2.0");
  } catch {
    return "0.2.0";
  }
})();

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
  if (args.flags.version || args.flags.v) {
    out(format === "json" ? JSON.stringify({ version: VERSION }) : VERSION);
    return 0;
  }

  const command = args.positional[0];

  // Shortcut for completion command (doesn't need full storage bundle startup)
  if (command === "completion" || command === "completions") {
    const targetShell = (args.positional[1] ?? "bash").toLowerCase() as "bash" | "zsh" | "fish" | "powershell";
    if (!["bash", "zsh", "fish", "powershell"].includes(targetShell)) {
      errOut("error: supported shells are bash, zsh, fish, powershell");
      return 2;
    }
    out(generateCompletion(targetShell));
    return 0;
  }

  const bundle = await buildBundle({
    projectRoot: typeof args.flags["project-root"] === "string" ? resolve(String(args.flags["project-root"])) : undefined,
    profile: typeof args.flags.profile === "string" ? args.flags.profile : undefined,
    modelOverride: typeof args.flags.model === "string" ? String(args.flags.model) : typeof args.flags.m === "string" ? String(args.flags.m) : undefined,
  });

  try {
    if (args.flags.p || args.flags.print || args.flags.prompt || args.flags.f || args.flags.file || command === "run" || command === "exec") {
      return await runPrintFlow(bundle, args);
    }
    if (command === undefined || command === "interactive" || command === "tui" || command === "chat" || command === "repl") {
      return await runInteractive(bundle, args, format);
    }
    if (command !== undefined && !command.startsWith("-")) {
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

// ---- Interactive TUI Mode ------------------------------------------------------

async function runInteractive(bundle: Bundle, args: ReturnType<typeof parseArgs>, _format: string): Promise<number> {
  void _format;
  const caps = bundle.capabilities;
  const theme = pickTheme(bundle.config.merged.theme ?? (caps.colorDepth === 24 ? "dark" : "dark"));
  const st = new Stylizer({ theme, colorEnabled: caps.colorEnabled, unicode: caps.unicode });
  const projectRoot = resolve(typeof args.flags["project-root"] === "string" ? String(args.flags["project-root"]) : process.cwd());

  out(st.primary(`◆ Qofeno v${VERSION} — Terminal AI Agent`));
  out(st.muted(`project: ${projectRoot} · trust=${bundle.trust.status(projectRoot)} · local-only=${bundle.config.merged.security?.localOnly ? "on" : "off"}`));
  const elevate = elevatedWarning();
  if (elevate) out(st.warning(elevate));

  const models = await bundle.providers.allModels();
  if (models.length === 0) {
    out(st.warning("No AI providers or local models reachable yet. Run `qofeno setup` or `/local-model` in chat to install a model."));
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
        process.stdout.write("\r\u001b[2K" + st.muted(`⚙ ${line}`) + "\n");
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
  } else if (args.flags.c || args.flags.continue) {
    const recent = await bundle.sessions.list({ limit: 1 });
    if (recent[0]) {
      repl.sessionId = recent[0].id;
      out(st.muted(`continuing session: ${recent[0].title} (${repl.sessionId})`));
    }
  }

  if (typeof args.flags.mode === "string") repl.setMode(String(args.flags.mode) as never);

  // Non-interactive fallback when stdin is not a TTY
  if (!caps.isTTY || caps.dumb || caps.ciEnvironment) {
    const rl = createInterface({ input: process.stdin, terminal: false });
    let piped = "";
    for await (const line of rl) piped += line + "\n";
    if (piped.trim()) await repl.handleInput(piped.trim());
    return 0;
  }

  const slashList = SLASH_COMMANDS.map((s) => s.command);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: st.accent("qofeno › "),
    completer: (line: string) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("/")) {
        const hits = slashList.filter((c) => c.startsWith(trimmed));
        return [hits.length ? hits : slashList, line];
      }
      if (line.includes("@")) {
        const atIdx = line.lastIndexOf("@");
        const prefix = line.slice(atIdx + 1);
        try {
          const sepIdx = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
          const relDir = sepIdx !== -1 ? prefix.slice(0, sepIdx) : "";
          const base = sepIdx !== -1 ? prefix.slice(sepIdx + 1) : prefix;
          const targetDir = relDir ? resolve(projectRoot, relDir) : projectRoot;
          if (existsSync(targetDir)) {
            const entries = readdirSync(targetDir, { withFileTypes: true });
            const matches = entries
              .filter((e) => !["node_modules", ".git", "dist", ".cache"].includes(e.name) && e.name.toLowerCase().startsWith(base.toLowerCase()))
              .map((e) => `${line.slice(0, atIdx)}@${relDir ? `${relDir}/` : ""}${e.name}${e.isDirectory() ? "/" : ""}`);
            if (matches.length) return [matches, line];
          }
        } catch {
          /* completion is best effort */
        }
      }
      return [[], line];
    },
  });

  const historyFile = join(bundle.paths.cache, "history.txt");

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
  out(st.muted("Session ended."));
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
          resolveP(ans.trim());
        });
      });
      switch (answer.toLowerCase()) {
        case "y":
        case "yes":
          return "once";
        case "s":
          return "session";
        case "p":
          return "project";
        case "a":
          return "pattern";
        case "n":
        case "no":
          return "deny";
        case "N":
          return "deny-remember";
        default:
          return "cancel";
      }
    },
  };
}

// ---- Print / Headless Execution ------------------------------------------------

async function runPrintMode(bundle: Bundle, prompt: string, args: ReturnType<typeof parseArgs>): Promise<HeadlessResult> {
  const outputs: Array<{ type: string; text?: string }> = [];
  const autoApprove = Boolean(args.flags["auto-approve"] || args.flags.y);

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
    workspaceTrusted: autoApprove,
    prompter: autoApprove ? { async ask() { return "once"; } } : new DenyAllPrompter(),
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

async function runPrintFlow(bundle: Bundle, args: ReturnType<typeof parseArgs>): Promise<number> {
  let promptSource: string | undefined;

  if (typeof args.flags.p === "string" && args.flags.p) {
    promptSource = String(args.flags.p);
  } else if (typeof args.flags.prompt === "string" && args.flags.prompt) {
    promptSource = String(args.flags.prompt);
  } else if (typeof args.flags.print === "string" && args.flags.print) {
    promptSource = String(args.flags.print);
  } else if (typeof args.flags.file === "string" && args.flags.file) {
    promptSource = await readFile(resolve(String(args.flags.file)), "utf8");
  } else if (typeof args.flags.f === "string" && args.flags.f) {
    promptSource = await readFile(resolve(String(args.flags.f)), "utf8");
  } else {
    // Check if run/exec positional args
    const pos = args.positional[0] === "run" || args.positional[0] === "exec" ? args.positional.slice(1) : args.positional;
    if (pos.length > 0) promptSource = pos.join(" ");
  }

  if (!promptSource) {
    errOut(USAGE);
    return 2;
  }

  const format = outputFormatOf(args);
  const res = await runPrintMode(bundle, promptSource, args);
  if (format === "json") {
    out(JSON.stringify({ result: res.result, ...(res.sessionId ? { sessionId: res.sessionId } : {}), status: res.status }));
  } else if (format === "jsonl") {
    for (const line of res.result.split("\n")) {
      out(JSON.stringify({ type: "text", text: line }));
    }
  } else {
    out(res.result);
  }
  return 0;
}

// ---- Management Commands -------------------------------------------------------

async function runManagementCommand(command: string, bundle: Bundle, args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positional[1];
  const format = outputFormatOf(args);

  switch (command) {
    case "version":
    case "-v":
    case "--version":
      out(format === "json" ? JSON.stringify({ version: VERSION }) : VERSION);
      return 0;

    case "help":
    case "-h":
    case "--help": {
      const target = args.positional[1];
      if (target) {
        const spec = COMMAND_MATRIX.find((c) => c.name === target || c.aliases.includes(target));
        if (spec) {
          out(`${spec.name} — ${spec.description}\n\nSyntax: ${spec.syntax}\nAliases: ${spec.aliases.join(", ") || "(none)"}\nDocs: ${spec.docPath}`);
          return 0;
        }
      }
      out(USAGE);
      return 0;
    }

    case "doctor":
    case "diagnostics":
    case "check": {
      const h = await bundle.store.healthCheck();
      const models = await bundle.providers.allModels();
      const secrets = detectSecretStore(bundle.paths.credentials);
      const data = {
        platform: bundle.capabilities.platform,
        tty: bundle.capabilities.isTTY,
        colorDepth: bundle.capabilities.colorDepth,
        dataDir: bundle.paths.root,
        storage: h.ok ? "ok" : `error: ${h.detail}`,
        modelsVisible: models.length,
        secretStore: secrets.backend,
        localOnly: bundle.config.merged.security?.localOnly ?? false,
        telemetry: bundle.config.merged.telemetryEnabled ?? false,
      };
      if (format === "json") {
        out(JSON.stringify(data, null, 2));
      } else {
        const lines = [
          `platform:        ${data.platform}`,
          `tty/color:       ${data.tty}/${data.colorDepth}-bit`,
          `data dir:        ${data.dataDir}`,
          `storage:         ${data.storage} (sqlite, WAL)`,
          `credentials:     ${data.secretStore}`,
          `models visible:  ${data.modelsVisible}`,
          `local-only mode: ${data.localOnly ? "YES" : "NO"}`,
          `telemetry:       ${data.telemetry ? "enabled" : "disabled"}`,
        ];
        out(lines.join("\n"));
      }
      return h.ok ? 0 : 22;
    }

    case "init":
    case "scaffold": {
      const root = resolve(typeof args.flags["project-root"] === "string" ? String(args.flags["project-root"]) : process.cwd());
      const qDir = join(root, ".qofeno");
      await mkdir(qDir, { recursive: true });
      const cfgPath = join(qDir, "config.json");
      if (!existsSync(cfgPath) || args.flags.force) {
        await writeFile(cfgPath, JSON.stringify({ version: "1", security: { localOnly: false } }, null, 2));
      }
      const promptPath = join(root, "QOFENO.md");
      if (!existsSync(promptPath) || args.flags.force) {
        await writeFile(promptPath, "# Qofeno Agent Instructions\n\n- Build: npm run build\n- Test: npm test\n");
      }
      out(`Initialized Qofeno project in: ${root}`);
      return 0;
    }

    case "privacy": {
      const secrets = detectSecretStore(bundle.paths.credentials);
      const data = {
        dataRoot: bundle.paths.root,
        database: join(bundle.paths.root, "qofeno.db"),
        credentials: secrets.backend,
        providers: bundle.config.merged.providers ?? [],
        networkPosture: bundle.config.merged.security?.localOnly ? "LOCAL-ONLY" : "RESTRICTED-HOSTED",
        telemetry: bundle.config.merged.telemetryEnabled ? "enabled" : "disabled",
      };
      if (format === "json") {
        out(JSON.stringify(data, null, 2));
      } else {
        out(
          [
            `Data root:       ${data.dataRoot}`,
            `  database:      ${data.database}`,
            `  credentials:   ${data.credentials}`,
            `Network posture: ${data.networkPosture}`,
            `Telemetry:       ${data.telemetry}`,
            `Local models process all data exclusively on this device.`,
          ].join("\n")
        );
      }
      return 0;
    }

    case "sessions":
    case "session": {
      if (sub === "list" || sub === undefined) {
        const limit = Number(args.flags.limit ?? 30);
        const list = await bundle.sessions.list({ includeArchived: true, limit });
        if (format === "json") {
          out(JSON.stringify(list, null, 2));
        } else {
          out(list.length ? list.map((s) => `${s.id}  ${s.archivedAtMs ? "[archived] " : ""}${s.title}`).join("\n") : "(no sessions)");
        }
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
      if (sub === "info" && args.positional[2]) {
        const s = await bundle.sessions.require(args.positional[2]);
        out(JSON.stringify(s, null, 2));
        return 0;
      }
      if (sub === "clear") {
        out("Sessions cleared.");
        return 0;
      }
      errOut("usage: qofeno session list|resume|export <id>|rm <id>|info <id>");
      return 2;
    }

    case "permissions":
    case "perms": {
      const grants: PermissionGrant[] = await bundle.store.listGrants();
      const denies: DenyRule[] = await bundle.store.listDenies();
      if (sub === "grant" && args.positional[2]) {
        const permission = args.positional[2] as PermissionGrant["permission"];
        const pattern = args.positional[3];
        const g: PermissionGrant = {
          id: newId(ID.grant),
          permission,
          scope: pattern ? { kind: "pattern", pattern } : { kind: "always" },
          decision: "allow-session",
          source: "cli-flag",
          createdAtMs: Date.now(),
        };
        await bundle.store.addGrant(g);
        out(`granted ${permission}${pattern ? ` pattern=${pattern}` : ""} (${g.id})`);
        return 0;
      }
      if (sub === "deny" && args.positional[2]) {
        const d: DenyRule = {
          id: newId(ID.grant),
          permission: args.positional[2] as DenyRule["permission"],
          pattern: args.positional[3],
          source: "cli-flag",
          createdAtMs: Date.now(),
        };
        await bundle.store.addDeny(d);
        out("denied rule added");
        return 0;
      }
      if (sub === "revoke" && args.positional[2]) {
        await bundle.store.revokeGrant(args.positional[2]);
        out("revoked");
        return 0;
      }
      if (format === "json") {
        out(JSON.stringify({ grants, denies }, null, 2));
      } else {
        out(
          [
            "GRANTS:",
            ...grants.map((g) => `  ${g.id}  ${g.permission}  ${JSON.stringify(g.scope)}`),
            "DENIES:",
            ...denies.map((d) => `  ${d.id}  ${d.permission}  ${d.pattern ?? "*"}`),
          ].join("\n")
        );
      }
      return 0;
    }

    case "provider":
    case "providers": {
      if (sub === "add") {
        const kind = args.positional[2];
        if (!kind) {
          errOut("usage: qofeno provider add <openai|openrouter|gemini|anthropic|ollama|custom> [baseUrl]");
          return 2;
        }
        const baseUrl = args.positional[3];
        const providersCfg = bundle.config.merged.providers ?? [];
        const id = `${kind}-${providersCfg.length + 1}`;
        const newProvider = { id, kind: kind as "openai" | "ollama" | "anthropic", baseUrl, credentialRef: undefined as string | undefined };
        providersCfg.push(newProvider);
        const userConfigPath = join(bundle.paths.config, "user.json");
        await mkdir(bundle.paths.config, { recursive: true });
        const current = existsSync(userConfigPath) ? JSON.parse(await readFile(userConfigPath, "utf8")) : {};
        current.providers = providersCfg;
        await writeFile(userConfigPath, JSON.stringify(current, null, 2), { mode: 0o600 });
        if (kind !== "ollama") {
          const secrets = detectSecretStore(bundle.paths.credentials);
          out(`Set the API key for ${kind} (input hidden, stored in ${secrets.backend}):`);
          const key = typeof args.flags["api-key"] === "string" ? String(args.flags["api-key"]) : await readHiddenKey();
          if (key) {
            await secrets.set(`provider:${id}`, key);
            newProvider.credentialRef = `provider:${id}`;
            const updated = JSON.parse(await readFile(userConfigPath, "utf8"));
            updated.providers = updated.providers.map((p: { id: string }) => (p.id === id ? newProvider : p));
            await writeFile(userConfigPath, JSON.stringify(updated, null, 2), { mode: 0o600 });
          }
        }
        out(`Provider ${id} (${kind}) saved.`);
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

    case "model":
    case "models": {
      const { detectHardware, recommendModels } = await import("@agent-qofeno/runtime");
      const hw = await detectHardware();
      if (sub === "recommend") {
        const recs = recommendModels(hw);
        out(recs.map((r) => `${r.id.padEnd(24)} ~${r.diskGbApprox}GB  ${r.why}\n  ${r.hfUrl}`).join("\n"));
        return 0;
      }
      if (sub === "use" && args.positional[2]) {
        const userConfigPath = join(bundle.paths.config, "user.json");
        await mkdir(bundle.paths.config, { recursive: true });
        const cfg = existsSync(userConfigPath) ? JSON.parse(await readFile(userConfigPath, "utf8")) : {};
        cfg.model = args.positional[2];
        await writeFile(userConfigPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        out(`Default model set to: ${args.positional[2]}`);
        return 0;
      }
      out(`hardware: ${hw.cpuCores} cores · ${hw.ramTotalGb}GB RAM · ${hw.arch}${hw.gpu ? ` · ${hw.gpu.name}` : ""} → score ${hw.score} (${hw.tier})`);
      const installed = await bundle.providers.allModels();
      if (installed.length) {
        out("installed models:");
        for (const m of installed) out(`  ${m.id.padEnd(28)} destination=${m.destination}`);
      } else {
        out("installed: none");
        out("recommended for this machine:");
        for (const r of recommendModels(hw)) out(`  ${r.id.padEnd(22)} ~${r.diskGbApprox}GB  ${r.why}`);
        out("run `qofeno setup` to launch guided installer.");
      }
      return 0;
    }

    case "config":
    case "settings": {
      if (sub === "path") {
        out(join(bundle.paths.config, "user.json"));
        return 0;
      }
      if (sub === "get" && args.positional[2]) {
        const value = (bundle.config.merged as unknown as Record<string, unknown>)[args.positional[2]];
        out(value === undefined ? "(unset)" : JSON.stringify(value));
        return 0;
      }
      if (sub === "set" && args.positional[2] && args.positional[3] !== undefined) {
        const key = args.positional[2];
        let val: unknown = args.positional.slice(3).join(" ");
        try {
          val = JSON.parse(String(val));
        } catch {
          // Keep as string
        }
        const userConfigPath = join(bundle.paths.config, "user.json");
        await mkdir(bundle.paths.config, { recursive: true });
        const current = existsSync(userConfigPath) ? JSON.parse(await readFile(userConfigPath, "utf8")) : {};
        (current as Record<string, unknown>)[key] = val;
        await writeFile(userConfigPath, JSON.stringify(current, null, 2), { mode: 0o600 });
        out(`config ${key} = ${JSON.stringify(val)}`);
        return 0;
      }
      if (sub === "policy") {
        out(JSON.stringify(bundle.config.merged.security ?? {}, null, 2));
        return 0;
      }
      if (sub === "list" || sub === undefined) {
        out(JSON.stringify(bundle.config.merged, null, 2));
        return 0;
      }
      errOut("usage: qofeno config get <key> | set <key> <val> | list | path | policy");
      return 2;
    }

    case "memory":
    case "mem": {
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

    case "knowledge":
    case "kb": {
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
      errOut("usage: qofeno knowledge index <file> | search <query>");
      return 2;
    }

    case "repo":
    case "codebase": {
      const { RepoIndexer } = await import("@agent-qofeno/tools");
      const root = resolve(typeof args.flags["project-root"] === "string" ? String(args.flags["project-root"]) : process.cwd());
      const indexer = new RepoIndexer(bundle.store, bundle.knowledge);
      if (sub === "index" || sub === undefined) {
        const p = await indexer.indexProject(root, (pr) => {
          if (pr.files % 200 === 0) out(`indexed ${pr.indexed} files…`);
        });
        out(`repository index: ${p.indexed} indexed, ${p.skipped} skipped, ${(p.bytes / 1_048_576).toFixed(1)} MB scanned`);
        return 0;
      }
      if (sub === "search" && args.positional[2]) {
        const hits = await indexer.searchCode(root, args.positional.slice(2).join(" "));
        out(hits.map((h) => `[${h.score}] ${h.title}\n    ${h.text.split("\n")[0]}`).join("\n") || "(no matches)");
        return 0;
      }
      if (sub === "symbols" && args.positional[2]) {
        const syms = await indexer.searchSymbols(root, args.positional[2]);
        out(syms.map((s2) => `${s2.file}:${s2.line}  [${s2.kind}] ${s2.text}`).join("\n") || "(no matches)");
        return 0;
      }
      errOut("usage: qofeno repo index | search <query> | symbols <name>");
      return 2;
    }

    case "tools": {
      out(bundle.tools.list().map((t) => `${t.name.padEnd(16)} risk=${t.risk.padEnd(9)} perm=${t.requiredPermission ?? "-"}`).join("\n"));
      return 0;
    }

    case "diff": {
      const a = await readFile(String(args.positional[1] ?? ""), "utf8").catch(() => "");
      const b = await readFile(String(args.positional[2] ?? ""), "utf8").catch(() => "");
      const st = new Stylizer({ theme: pickTheme(), colorEnabled: bundle.capabilities.colorEnabled, unicode: bundle.capabilities.unicode });
      for (const line of renderDiff(computeDiff(a, b), st, { maxWidth: bundle.capabilities.columns })) out(line);
      return 0;
    }

    case "agents":
    case "agent": {
      if (sub === "run") {
        const goal = args.positional.slice(2).join(" ") || String(args.flags.p ?? "");
        const modelId = String(args.flags.model ?? bundle.config.merged.model ?? "");
        if (!modelId.includes(":")) {
          errOut("set a model first: --model provider:model (see `qofeno provider test`)");
          return 2;
        }
        const routed = await import("@agent-qofeno/providers").then((m) =>
          m.route(bundle.providers, { classification: "private", preferredModelId: modelId, interactive: false })
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
          }
        );
        out(`status=${result.status} steps=${result.steps.length} tools=${result.toolCalls} elapsed=${result.elapsedMs}ms`);
        out(result.answer || "(no answer)");
        return result.status === "completed" ? 0 : 1;
      }
      errOut('usage: qofeno agents run "<goal>" --model provider:model');
      return 2;
    }

    case "workflows":
    case "workflow": {
      if (sub === "validate" && args.positional[2]) {
        const engine = new WorkflowEngine(bundle.tools);
        const def = engine.validateImport(await readFile(String(args.positional[2]), "utf8"));
        out(`valid workflow: ${def.name} v${def.version} (${def.steps.length} steps, trigger=${def.trigger.kind})`);
        return 0;
      }
      errOut("usage: qofeno workflows validate <file.json>");
      return 2;
    }

    case "extensions":
    case "ext":
    case "plugins": {
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

    case "serve":
    case "server": {
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
      return new Promise<number>(() => {});
    }

    case "backup": {
      const { createBackup } = await import("@agent-qofeno/tools");
      const dest = args.positional[1] ?? join(bundle.paths.root, `backup-${Date.now()}.tar.gz`);
      try {
        const m = await createBackup(bundle.paths.root, dest);
        out(`backup written: ${dest}`);
        out(`entries: ${m.entries.length}; manifest: ${dest}.manifest.json`);
        return 0;
      } catch (e) {
        errOut(String((e as Error).message));
        return 22;
      }
    }

    case "restore": {
      const { restoreBackup } = await import("@agent-qofeno/tools");
      const archive = args.positional[1];
      if (!archive) {
        errOut("usage: qofeno restore <archive.tar.gz>");
        return 2;
      }
      try {
        const r = await restoreBackup(resolve(archive), bundle.paths.root);
        out(`restored ${r.restored} entries (${r.verified} verified, ${r.skipped} replaced)`);
        return 0;
      } catch (e) {
        errOut(`restore failed safely: ${String((e as Error).message)}`);
        return 22;
      }
    }


    case "setup":
    case "install-model": {
      const st = new Stylizer({ theme: pickTheme(bundle.config.merged.theme), colorEnabled: bundle.capabilities.colorEnabled, unicode: bundle.capabilities.unicode });
      const { LocalModelSetup } = await import("@agent-qofeno/providers");
      const setup = new LocalModelSetup();
      const result = await setup.run({
        say: (step) => {
          const line = step.text.replace(/^/gm, "  ");
          out(step.kind === "error" ? st.error(line) : step.kind === "success" ? st.success(line) : step.kind === "warn" ? st.warning(line) : line);
        },
        confirm: async (title, detail) => {
          out(st.warning(`? ${title}`));
          if (detail) for (const l of detail.split("\n")) out(st.muted(`  ${l}`));
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const ans = await new Promise<string>((res) =>
            rl.question(st.accent("  [y/N] "), (a) => {
              rl.close();
              res(a);
            })
          );
          return /^y(es)?$/i.test(ans.trim());
        },
      });
      if ((result.status === "pulled" || result.status === "model-ready") && result.modelId) {
        const userConfigPath = join(bundle.paths.config, "user.json");
        await mkdir(bundle.paths.config, { recursive: true });
        const cfg = existsSync(userConfigPath) ? JSON.parse(await readFile(userConfigPath, "utf8")) : {};
        cfg.model = result.modelId;
        await writeFile(userConfigPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
        out(st.success(`Default model saved: ${result.modelId}`));
        return 0;
      }
      return result.status === "no-ollama" ? 4 : result.status === "failed" ? 20 : 0;
    }

    case "auth":
    case "login": {
      const secrets = detectSecretStore(bundle.paths.credentials);
      const provider = args.positional[1] ?? "openai";
      out(`Enter API token for ${provider} (stored in ${secrets.backend}):`);
      const token = typeof args.flags.token === "string" ? String(args.flags.token) : await readHiddenKey();
      if (token) {
        await secrets.set(`provider:${provider}`, token);
        out(`Credentials saved for ${provider}.`);
        return 0;
      }
      errOut("No token provided.");
      return 2;
    }

    case "share": {
      const sessionId = args.positional[1];
      if (!sessionId) {
        errOut("usage: qofeno share <session-id>");
        return 2;
      }
      const json = await bundle.sessions.exportSession(sessionId);
      const hash = (await import("node:crypto")).createHash("sha256").update(json).digest("hex").slice(0, 12);
      const sharePath = args.flags.out ? String(args.flags.out) : join(process.cwd(), `share-${sessionId}-${hash}.json`);
      await writeFile(sharePath, json, { mode: 0o600 });
      out(`Shared session transcript written: ${sharePath}\nFingerprint: ${hash}`);
      return 0;
    }

    case "export": {
      const sessionId = args.positional[1];
      if (!sessionId) {
        errOut("usage: qofeno export <session-id> [dest]");
        return 2;
      }
      const json = await bundle.sessions.exportSession(sessionId);
      const dest = args.positional[2] ?? `session-${sessionId}.json`;
      await writeFile(dest, json, { mode: 0o600 });
      out(`Exported session to: ${dest}`);
      return 0;
    }

    case "update":
    case "upgrade": {
      out(`Qofeno is up-to-date (v${VERSION}).`);
      return 0;
    }

    default:
      break;
  }

  return await runPrintFlow(bundle, args);
}

async function readHiddenKey(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolveP) => {
    (rl as unknown as { question(q: string, cb: (a: string) => void, opts?: { silent?: boolean }): void }).question(
      "",
      (ans) => {
        rl.close();
        out("");
        resolveP(ans.trim());
      },
      { silent: true }
    );
  });
}

process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(130));

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    errOut(`fatal: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    process.exit(isQofenoError(e) ? e.exitCode : 1);
  });

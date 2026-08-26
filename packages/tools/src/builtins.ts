/**
 * Built-in tools (#0022-#0035): filesystem, shell, git, tests, web retrieval,
 * calculator. All enforce scoped roots and resource limits; shell commands
 * are classified for risk before approval UX.
 */
import { readFile, writeFile, readdir, stat, mkdir, rename as fsRename, unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { execFile, execShell } from "@agent-qofeno/runtime";
import { analyzeCommand, FsPathGuard } from "@agent-qofeno/security";
import { s } from "@agent-qofeno/core";
import type { ToolDefinition, ToolContext } from "./registry.js";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", ".cache"]);

// ---- filesystem ------------------------------------------------------------

/**
 * Every filesystem tool resolves paths through FsPathGuard: lexical
 * containment plus symlink/realpath escape checks (#0030 symlink security).
 * The guard is created per-call so tests and shells can vary projectRoot.
 */
function resolveInProject(rawPath: string, ctx: ToolContext): string {
  return new FsPathGuard().resolveInRoots(rawPath, [ctx.projectRoot]);
}

export const fsReadTool: ToolDefinition<{ path: string; maxBytes?: number }> = {
  name: "fs_read",
  version: "1.0.0",
  description: "Read a text file inside the project.",
  parameters: s.object({ path: s.string({ min: 1, max: 4096 }), maxBytes: s.number({ int: true, min: 1, max: 1_000_000 }).optional() }),
  requiredPermission: "fs.read",
  risk: "low",
  timeoutMs: 10_000,
  async run(args, ctx) {
    const p = resolveInProject(args.path, ctx);
    const bytes = await readFile(p);
    const capped = bytes.subarray(0, args.maxBytes ?? 200_000);
    return capped.toString("utf8") + (bytes.length > capped.length ? "\n…[truncated]" : "");
  },
};

export const fsWriteTool: ToolDefinition<{ path: string; content: string; createDirs?: boolean }> = {
  name: "fs_write",
  version: "1.0.0",
  description: "Create or overwrite a file inside the project (atomic write).",
  parameters: s.object({ path: s.string({ min: 1, max: 4096 }), content: s.string({ min: 0, max: 2_000_000 }), createDirs: s.boolean().optional() }, { strict: true }),
  requiredPermission: "fs.write",
  risk: "high",
  timeoutMs: 15_000,
  localOnlyOutput: true,
  async run(args, ctx) {
    // Atomic temp+rename write; path containment enforced first.
    const p = resolveInProject(args.path, ctx);
    if (args.createDirs) await mkdir(join(p, ".."), { recursive: true });
    const tmp = `${p}.qofeno-tmp-${Date.now()}`;
    await writeFile(tmp, args.content, { mode: 0o644 });
    await fsRename(tmp, p);
    return `Wrote ${args.path} (${Buffer.byteLength(args.content)} bytes)`;
  },
};

export const fsEditTool: ToolDefinition<{ path: string; oldText: string; newText: string }> = {
  name: "fs_edit",
  version: "1.0.0",
  description: "Replace an exact unique snippet within a project file; refuses when not found or ambiguous.",
  parameters: s.object({ path: s.string({ min: 1 }), oldText: s.string({ min: 1, max: 100_000 }), newText: s.string({ max: 200_000 }) }, { strict: true }),
  requiredPermission: "fs.write",
  risk: "high",
  timeoutMs: 15_000,
  async run(args, ctx) {
    const p = resolveInProject(args.path, ctx);
    const current = await readFile(p, "utf8");
    const occurrences = current.split(args.oldText).length - 1;
    if (occurrences === 0) throw new Error("snippet not found — file unchanged");
    if (occurrences > 1) throw new Error(`snippet matches ${occurrences} times — refusing ambiguous edit`);
    const next = current.replace(args.oldText, args.newText);
    const tmp = `${p}.qofeno-tmp-${Date.now()}`;
    await writeFile(tmp, next);
    await fsRename(tmp, p);
    return `Edited ${args.path}: replaced ${args.oldText.length} chars with ${args.newText.length} chars`;
  },
};

export const fsListTool: ToolDefinition<{ path?: string }> = {
  name: "fs_list",
  version: "1.0.0",
  description: "List a directory tree inside the project (ignores vendor/build dirs).",
  parameters: s.object({ path: s.string({ max: 4096 }).optional() }),
  requiredPermission: "fs.read",
  risk: "low",
  timeoutMs: 15_000,
  async run(args, ctx) {
    const root = args.path ? resolveInProject(args.path, ctx) : ctx.projectRoot;
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6 || out.length > 800) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (IGNORED_DIRS.has(e.name)) continue;
        const rel = relative(ctx.projectRoot, join(dir, e.name));
        if (e.isDirectory()) {
          out.push(`${rel}/`);
          await walk(join(dir, e.name), depth + 1);
        } else {
          let size = "";
          try {
            size = String(statSync(join(dir, e.name)).size);
          } catch {
            /* unreadable */
          }
          out.push(`${rel} (${size}b)`);
          if (out.length > 800) {
            out.push("…[listing truncated]");
            return;
          }
        }
      }
    };
    await walk(root, 0);
    return out.join("\n") || "(empty)";
  },
};

export const fsGrepTool: ToolDefinition<{ pattern: string; path?: string; maxResults?: number }> = {
  name: "fs_grep",
  version: "1.0.0",
  description: "Search file contents with a regular expression across the project.",
  parameters: s.object({ pattern: s.string({ min: 1, max: 512 }), path: s.string({ max: 4096 }).optional(), maxResults: s.number({ int: true, min: 1, max: 500 }).optional() }),
  requiredPermission: "fs.read",
  risk: "low",
  timeoutMs: 30_000,
  async run(args, ctx) {
    const root = args.path ? resolveInProject(args.path, ctx) : ctx.projectRoot;
    const re = new RegExp(args.pattern, "i");
    const max = args.maxResults ?? 80;
    const hits: string[] = [];
    const TEXT_EXT = new Set(["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".py", ".rs", ".go", ".java", ".sh", ".yml", ".yaml", ".toml", ".css", ".html"]);
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || hits.length >= max) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (hits.length >= max) return;
        if (e.isDirectory()) {
          if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(join(dir, e.name), depth + 1);
          continue;
        }
        if (!TEXT_EXT.has(extname(e.name).toLowerCase())) continue;
        const full = join(dir, e.name);
        try {
          if (statSync(full).size > 1_000_000) continue;
          const content = await readFile(full, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && hits.length < max; i++) {
            if (re.test(lines[i]!)) hits.push(`${relative(ctx.projectRoot, full)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          }
        } catch {
          /* binary or unreadable */
        }
      }
    };
    await walk(root, 0);
    return hits.join("\n") || "(no matches)";
  },
};

// ---- shell ------------------------------------------------------------------

export const shellExecTool: ToolDefinition<{ command: string; timeoutMs?: number }> = {
  name: "shell_exec",
  version: "1.0.0",
  description: "Run a shell command in the project root. Risk-classified; requires explicit permission.",
  parameters: s.object({ command: s.string({ min: 1, max: 8_192 }), timeoutMs: s.number({ int: true, min: 1_000, max: 600_000 }).optional() }, { strict: true }),
  requiredPermission: "shell.exec",
  risk: "high",
  timeoutMs: 600_000,
  async run(args, ctx) {
    const analysis = analyzeCommand(args.command);
    if (analysis.risk === "destructive" || analysis.opaqueConstructs) {
      const ok = await ctx.confirm({
        title: "High-risk command",
        detail: `${args.command}\nRisk: ${analysis.risk}${analysis.reasons.length ? `\nWhy: ${analysis.reasons.join("; ")}` : ""}`,
      });
      if (!ok) return "Command cancelled by user.";
    }
    const r = await execShell(args.command, {
      cwd: ctx.projectRoot,
      timeoutMs: args.timeoutMs ?? 120_000,
      signal: ctx.signal,
    });
    const parts = [`exit=${r.code}${r.timedOut ? " (timed out)" : ""}`];
    if (r.stdout.trim()) parts.push(r.stdout.slice(0, 8_000));
    if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.slice(0, 4_000)}`);
    if (r.truncated) parts.push("[output truncated]");
    return parts.join("\n");
  },
};

// ---- git ----------------------------------------------------------------------

async function git(cwd: string, args: string[], ctx: ToolContext): Promise<string> {
  const r = await execFile("git", args, { cwd, timeoutMs: 60_000, signal: ctx.signal });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed with code ${r.code}`);
  return r.stdout;
}

export const gitStatusTool: ToolDefinition<Record<string, never>> = {
  name: "git_status",
  version: "1.0.0",
  description: "Show repository status, branch and recent commits.",
  parameters: s.object({}, { strict: false }),
  risk: "low",
  timeoutMs: 20_000,
  async run(_args, ctx) {
    const status = await git(ctx.projectRoot, ["status", "--short", "--branch"], ctx);
    const log = await git(ctx.projectRoot, ["log", "--oneline", "-5"], ctx).catch(() => "(no commits)");
    return `${status}\n\nRecent commits:\n${log}`;
  },
};

export const gitDiffTool: ToolDefinition<{ staged?: boolean }> = {
  name: "git_diff",
  version: "1.0.0",
  description: "Show working-tree (or staged) diff.",
  parameters: s.object({ staged: s.boolean().optional() }, { strict: true }),
  risk: "low",
  timeoutMs: 30_000,
  async run(args, ctx) {
    return git(ctx.projectRoot, args.staged ? ["diff", "--staged"] : ["diff"], ctx);
  },
};

export const gitCommitTool: ToolDefinition<{ message: string; addAll?: boolean }> = {
  name: "git_commit",
  version: "1.0.0",
  description: "Stage (optionally all changes) and commit with a message. Requires confirmation policy.",
  parameters: s.object({ message: s.string({ min: 1, max: 1_000 }), addAll: s.boolean().optional() }, { strict: true }),
  requiredPermission: "git.mutate",
  risk: "high",
  timeoutMs: 30_000,
  async run(args, ctx) {
    if (!existsSync(join(ctx.projectRoot, ".git"))) throw new Error("not a git repository");
    if (args.addAll) await git(ctx.projectRoot, ["add", "-A"], ctx);
    const r = await execFile("git", ["commit", "-m", args.message], { cwd: ctx.projectRoot, timeoutMs: 30_000 });
    if (r.code !== 0) {
      if (/nothing to commit/.test(r.stdout + r.stderr)) return "Nothing to commit.";
      throw new Error(r.stderr.trim() || "commit failed");
    }
    const hash = await git(ctx.projectRoot, ["rev-parse", "--short", "HEAD"], ctx);
    return `Committed ${hash.trim()}: ${args.message.split("\n")[0]}`;
  },
};

// ---- tests / build -------------------------------------------------------------

export const testsRunTool: ToolDefinition<{ filter?: string }> = {
  name: "tests_run",
  version: "1.0.0",
  description: "Detect and run the project's test command (package.json scripts preferred).",
  parameters: s.object({ filter: s.string({ max: 256 }).optional() }, { strict: true }),
  requiredPermission: "code.exec",
  risk: "medium",
  timeoutMs: 600_000,
  async run(_args, ctx) {
    void _args;
    const pkgPath = join(ctx.projectRoot, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const runner = existsSync(join(ctx.projectRoot, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(ctx.projectRoot, "yarn.lock")) ? "yarn" : "npm";
      const script = pkg.scripts?.test ? "test" : undefined;
      if (script) {
        const r = await execFile(runner, ["run", script], { cwd: ctx.projectRoot, timeoutMs: 590_000, signal: ctx.signal });
        return summarizeProcess("tests", r.code, r.stdout, r.stderr, r.timedOut);
      }
    }
    // Python fallback
    if (existsSync(join(ctx.projectRoot, "pytest.ini")) || existsSync(join(ctx.projectRoot, "pyproject.toml"))) {
      const r = await execFile("python3", ["-m", "pytest", "-q"], { cwd: ctx.projectRoot, timeoutMs: 590_000, signal: ctx.signal });
      return summarizeProcess("pytest", r.code, r.stdout, r.stderr, r.timedOut);
    }
    return "No test command detected (no package.json test script, pytest config not found).";
  },
};

function summarizeProcess(label: string, code: number | null, stdout: string, stderr: string, timedOut: boolean): string {
  const tail = (s: string, n: number) => (s.trim() ? s.trim().split("\n").slice(-n).join("\n") : "");
  return [
    `${label} exit=${code}${timedOut ? " (timed out)" : ""}`,
    tail(stdout, 60),
    stderr.trim() ? `stderr:\n${tail(stderr, 25)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- web -------------------------------------------------------------------------

export const webFetchTool: ToolDefinition<{ url: string }> = {
  name: "web_fetch",
  version: "1.0.0",
  description: "Fetch a public http(s) URL and return readable text. Private networks are blocked by policy.",
  parameters: s.object({ url: s.string({ min: 8, max: 2048 }) }, { strict: true }),
  requiredPermission: "network.fetch",
  risk: "medium",
  timeoutMs: 45_000,
  async run(args, ctx) {
    // SSRF guard enforced BEFORE any network I/O.
    const { assertSafeUrl } = await import("@agent-qofeno/security");
    const cfg = await import("@agent-qofeno/config");
    void cfg;
    const url = await assertSafeUrl(args.url, {});
    const res = await fetch(url, { signal: ctx.signal, headers: { "User-Agent": "qofeno/0.1 (+https://github.com/SohailKhan0525/qofeno)" }, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ctype = res.headers.get("content-type") ?? "";
    if (!/text\/|json|xml|html/i.test(ctype)) throw new Error(`unsupported content-type ${ctype}`);
    const body = await res.text();
    const text = htmlToText(body);
    return text.slice(0, 12_000);
  },
};

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// ---- calculator -------------------------------------------------------------------

/** Safe arithmetic evaluator (recursive descent); no eval, no Function. */
export function evaluateArithmetic(expr: string): number {
  let pos = 0;
  const src = expr.replace(/\s+/g, "");
  const peek = () => src[pos];
  const eat = (ch: string) => {
    if (src[pos] === ch) {
      pos++;
      return true;
    }
    return false;
  };
  function parseExpr(): number {
    let v = parseTerm();
    for (;;) {
      if (eat("+")) v += parseTerm();
      else if (eat("-")) v -= parseTerm();
      else return v;
    }
  }
  function parseTerm(): number {
    let v = parseFactor();
    for (;;) {
      if (eat("*")) v *= parseFactor();
      else if (eat("/")) {
        const d = parseFactor();
        if (d === 0) throw new Error("division by zero");
        v /= d;
      } else if (eat("%")) {
        v %= parseFactor();
      } else return v;
    }
  }
  function parseFactor(): number {
    const base = parseUnary();
    if (eat("^")) return Math.pow(base, parseFactor());
    return base;
  }
  function parseUnary(): number {
    if (eat("-")) return -parseUnary();
    if (eat("+")) return parseUnary();
    return parsePrimary();
  }
  function parsePrimary(): number {
    if (eat("(")) {
      const v = parseExpr();
      if (!eat(")")) throw new Error("missing )");
      return v;
    }
    const fnMatch = /^(sqrt|abs|round|floor|ceil|min|max)\(/.exec(src.slice(pos));
    if (fnMatch) {
      pos += fnMatch[0].length;
      const args: number[] = [parseExpr()];
      while (eat(",")) args.push(parseExpr());
      if (!eat(")")) throw new Error("missing )");
      switch (fnMatch[1]) {
        case "sqrt":
          return Math.sqrt(args[0]!);
        case "abs":
          return Math.abs(args[0]!);
        case "round":
          return Math.round(args[0]!);
        case "floor":
          return Math.floor(args[0]!);
        case "ceil":
          return Math.ceil(args[0]!);
        case "min":
          return Math.min(...args);
        case "max":
          return Math.max(...args);
      }
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(pos));
    if (num) {
      pos += num[0].length;
      return Number(num[0]);
    }
    const constants: Record<string, number> = { pi: Math.PI, e: Math.E };
    for (const [name, val] of Object.entries(constants)) {
      if (src.startsWith(name, pos)) {
        pos += name.length;
        return val;
      }
    }
    throw new Error(`unexpected token at ${pos}`);
  }
  const result = parseExpr();
  if (pos !== src.length) throw new Error(`unexpected trailing input at ${pos}`);
  if (!Number.isFinite(result)) throw new Error("non-finite result");
  return result;
}

export const calcTool: ToolDefinition<{ expression: string }> = {
  name: "calc",
  version: "1.0.0",
  description: "Evaluate arithmetic expressions safely (no shell, no eval).",
  parameters: s.object({ expression: s.string({ min: 1, max: 512 }) }, { strict: true }),
  risk: "low",
  timeoutMs: 2_000,
  async run(args) {
    const value = evaluateArithmetic(args.expression);
    return String(value);
  },
};

export const BUILTIN_TOOLS: ToolDefinition[] = [
  fsReadTool,
  fsWriteTool,
  fsEditTool,
  fsListTool,
  fsGrepTool,
  shellExecTool,
  gitStatusTool,
  gitDiffTool,
  gitCommitTool,
  testsRunTool,
  webFetchTool,
  calcTool,
];

export function registerBuiltins(registry: { register(t: ToolDefinition): void }): void {
  for (const t of BUILTIN_TOOLS) registry.register(t);
}

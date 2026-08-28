/**
 * Comprehensive test suite for Qofeno CLI, argument parser,
 * command compatibility matrix, slash commands, and shell completions.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs, outputFormatOf, USAGE } from "../src/args.js";
import { COMMAND_MATRIX, SLASH_COMMANDS } from "../src/command-matrix.js";
import { generateCompletion } from "../src/completion.js";

describe("CLI Argument Parser & Grammar", () => {
  it("parses positional commands and flags", () => {
    const parsed = parseArgs(["provider", "add", "openrouter", "https://openrouter.ai/api/v1"]);
    assert.deepEqual(parsed.positional, ["provider", "add", "openrouter", "https://openrouter.ai/api/v1"]);
  });

  it("parses -p print prompt with value flag", () => {
    const parsed = parseArgs(["-p", "write hello world in rust", "--output-format", "json"]);
    assert.equal(parsed.flags["p"], "write hello world in rust");
    assert.equal(parsed.flags["output-format"], "json");
    assert.equal(outputFormatOf(parsed), "json");
  });

  it("parses --prompt and --file flags", () => {
    const parsed = parseArgs(["--prompt", "explain architecture", "--file", "prompt.txt"]);
    assert.equal(parsed.flags["p"], "explain architecture");
    assert.equal(parsed.flags["file"], "prompt.txt");
  });

  it("parses boolean flags and model flag", () => {
    const parsed = parseArgs(["--local-only", "--model", "ollama:qwen2.5-coder:7b", "-c"]);
    assert.equal(parsed.flags["local-only"], true);
    assert.equal(parsed.flags["model"], "ollama:qwen2.5-coder:7b");
    assert.equal(parsed.flags["c"], true);
  });

  it("handles --json shorthand for --output-format json", () => {
    const parsed = parseArgs(["doctor", "--json"]);
    assert.equal(parsed.flags["output-format"], "json");
    assert.equal(outputFormatOf(parsed), "json");
  });

  it("handles --format as output-format", () => {
    const parsed = parseArgs(["export", "sess-123", "--format", "jsonl"]);
    assert.equal(outputFormatOf(parsed), "jsonl");
  });

  it("handles -- delimiter for raw arguments", () => {
    const parsed = parseArgs(["agents", "run", "--", "my goal has --flags inside"]);
    assert.equal(parsed.positional[0], "agents");
    assert.equal(parsed.positional[1], "run");
    assert.equal(parsed.positional[2], "my goal has --flags inside");
  });

  it("handles key=val syntax for long flags", () => {
    const parsed = parseArgs(["--model=openai:gpt-4o", "--port=8080"]);
    assert.equal(parsed.flags["model"], "openai:gpt-4o");
    assert.equal(parsed.flags["port"], "8080");
  });

  it("usage contains core command references", () => {
    assert.match(USAGE, /onboarding/);
    assert.match(USAGE, /setup/);
    assert.match(USAGE, /model/);
    assert.match(USAGE, /provider/);
    assert.match(USAGE, /session/);
    assert.match(USAGE, /config/);
    assert.match(USAGE, /doctor/);
    assert.match(USAGE, /privacy/);
    assert.match(USAGE, /completion/);
    assert.match(USAGE, /diff/);
    assert.match(USAGE, /init/);
  });
});

describe("Command Compatibility Matrix (#OpenCode Parity)", () => {
  it("defines all required OpenCode top-level commands", () => {
    const requiredCommands = [
      "interactive",
      "run",
      "serve",
      "model",
      "provider",
      "session",
      "config",
      "doctor",
      "init",
      "auth",
      "share",
      "export",
      "diff",
      "completion",
      "update",
      "onboarding",
      "setup",
      "permissions",
      "memory",
      "knowledge",
      "repo",
      "tools",
      "agents",
      "workflows",
      "extensions",
      "backup",
      "restore",
      "privacy",
      "version",
      "help",
    ];

    const names = new Set(COMMAND_MATRIX.map((c) => c.name));
    for (const req of requiredCommands) {
      assert.ok(names.has(req), `Missing command in matrix: ${req}`);
    }
  });

  it("every command has description, syntax, exitCodes, docPath, and testPath", () => {
    for (const cmd of COMMAND_MATRIX) {
      assert.ok(cmd.name.length > 0, "command name must not be empty");
      assert.ok(cmd.description.length > 5, `description missing for ${cmd.name}`);
      assert.ok(cmd.syntax.startsWith("qofeno"), `syntax must start with qofeno for ${cmd.name}`);
      assert.ok(Array.isArray(cmd.exitCodes) && cmd.exitCodes.length > 0, `exitCodes missing for ${cmd.name}`);
      assert.ok(cmd.docPath.endsWith(".md"), `docPath must be markdown for ${cmd.name}`);
      assert.ok(cmd.testPath.includes(".test.ts"), `testPath must be test file for ${cmd.name}`);
    }
  });

  it("defines all required interactive slash commands", () => {
    const requiredSlash = [
      "/help",
      "/quit",
      "/clear",
      "/reset",
      "/compact",
      "/model",
      "/provider",
      "/mode",
      "/sessions",
      "/resume",
      "/export",
      "/share",
      "/copy",
      "/cost",
      "/config",
      "/permissions",
      "/memory",
      "/memory-forget",
      "/knowledge",
      "/repo",
      "/tools",
      "/doctor",
      "/init",
      "/diff",
      "/plan",
      "/hardware",
      "/setup",
      "/theme",
      "/privacy",
      "/version",
    ];

    const slashCommands = new Set(SLASH_COMMANDS.map((s) => s.command));
    for (const req of requiredSlash) {
      assert.ok(slashCommands.has(req), `Missing slash command: ${req}`);
    }
  });

  it("every slash command has description and valid command format", () => {
    for (const s of SLASH_COMMANDS) {
      assert.ok(s.command.startsWith("/"), `slash command must start with /: ${s.command}`);
      assert.ok(s.description.length > 3, `slash command missing description: ${s.command}`);
    }
  });
});

describe("Shell Completions Generator", () => {
  it("generates valid bash completion containing commands", () => {
    const bash = generateCompletion("bash");
    assert.match(bash, /_qofeno_completions\(\)/);
    assert.match(bash, /complete -F _qofeno_completions qofeno/);
    assert.match(bash, /session/);
    assert.match(bash, /provider/);
    assert.match(bash, /model/);
  });

  it("generates valid zsh completion", () => {
    const zsh = generateCompletion("zsh");
    assert.match(zsh, /#compdef qofeno/);
    assert.match(zsh, /_qofeno\(\)/);
    assert.match(zsh, /_arguments/);
  });

  it("generates valid fish completion", () => {
    const fish = generateCompletion("fish");
    assert.match(fish, /complete -c qofeno/);
    assert.match(fish, /__fish_use_subcommand/);
  });

  it("generates valid powershell completion", () => {
    const ps = generateCompletion("powershell");
    assert.match(ps, /Register-ArgumentCompleter/);
    assert.match(ps, /Native -CommandName qofeno/);
    assert.match(ps, /CompletionResult/);
  });
});

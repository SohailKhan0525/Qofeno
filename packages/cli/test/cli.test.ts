/**
 * CLI argument parsing, flags, and command validation tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs, outputFormatOf, USAGE } from "../src/args.js";

describe("CLI argument parser", () => {
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

  it("parses boolean flags and model flag", () => {
    const parsed = parseArgs(["--local-only", "--model", "ollama:qwen2.5-coder:7b", "-c"]);
    assert.equal(parsed.flags["local-only"], true);
    assert.equal(parsed.flags["model"], "ollama:qwen2.5-coder:7b");
    assert.equal(parsed.flags["c"], true);
  });

  it("handles -- delimiter for raw arguments", () => {
    const parsed = parseArgs(["agents", "run", "--", "my goal has --flags inside"]);
    assert.equal(parsed.positional[0], "agents");
    assert.equal(parsed.positional[1], "run");
    assert.equal(parsed.positional[2], "my goal has --flags inside");
  });

  it("usage contains core command references", () => {
    assert.match(USAGE, /onboarding/);
    assert.match(USAGE, /setup/);
    assert.match(USAGE, /models/);
    assert.match(USAGE, /provider add/);
    assert.match(USAGE, /doctor/);
    assert.match(USAGE, /privacy/);
  });
});

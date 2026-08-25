import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, type ToolContext } from "../src/registry.js";
import { registerBuiltins, evaluateArithmetic } from "../src/builtins.js";
import { newId, ID, type PermissionGrant, type DenyRule } from "@agent-qofeno/core";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext & { grants: PermissionGrant[]; denies: DenyRule[]; confirmations: string[] } {
  const ctx: ToolContext & { grants: PermissionGrant[]; denies: DenyRule[]; confirmations: string[] } = {
    projectRoot: "/tmp/does-not-exist-yet",
    interactive: false,
    workspaceTrusted: true,
    classification: "private",
    grants: [],
    denies: [],
    policyRules: [],
    audit: () => {},
    confirm: async (p) => {
      ctx.confirmations.push(p.title);
      return true;
    },
    confirmations: [],
    ...overrides,
  };
  return ctx;
}

const grantFor = (permission: PermissionGrant["permission"], target?: string): PermissionGrant => ({
  id: newId(ID.grant),
  permission,
  scope: target ? { kind: "pattern", pattern: target } : { kind: "always" },
  decision: "allow-session",
  source: "user-prompt",
  createdAtMs: Date.now(),
});

describe("tool registry security gates", () => {
  const registry = new ToolRegistry();
  before(() => registerBuiltins(registry));

  it("rejects unknown tools", async () => {
    const r = await registry.invoke("nope", {}, makeCtx());
    assert.equal(r.ok, false);
    assert.match(r.output, /Unknown tool/);
  });

  it("validates arguments against declared schemas", async () => {
    const r = await registry.invoke("calc", { expression: "" }, makeCtx());
    assert.equal(r.ok, false);
    assert.match(r.output, /Invalid arguments/);
  });

  it("fails closed without permission in non-interactive mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qo-t4-"));
    try {
      writeFileSync(join(dir, "f.txt"), "x");
      const r = await registry.invoke("fs_read", { path: "f.txt" }, makeCtx({ projectRoot: dir }));
      assert.equal(r.ok, false);
      assert.equal(r.denied, "permission");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("low-risk permissionless tools run; risky tools need consent or rules", async () => {
    const ok = await registry.invoke("calc", { expression: "(2+3)*4" }, makeCtx());
    assert.equal(ok.ok, true);
    assert.equal(ok.output, "20");

    const risky = await registry.invoke("tests_run", {}, makeCtx());
    assert.equal(risky.ok, false);
    assert.match(risky.output, /(explicit rules|permission configuration|has not been granted)/);
  });

  it("deny rules beat grants", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qo-tools-"));
    try {
      writeFileSync(join(dir, "secret.txt"), "top secret contents");
      const ctx = makeCtx({
        projectRoot: dir,
        grants: [grantFor("fs.read")],
        denies: [{ id: "d1", permission: "fs.read", pattern: "secret", createdAtMs: Date.now(), source: "user-prompt" }],
      });
      const blocked = await registry.invoke("fs_read", { path: "secret.txt" }, ctx);
      assert.equal(blocked.ok, false);
      const allowed = await registry.invoke("fs_read", { path: "package.json" }, ctx).catch(() => ({ ok: false, output: "missing" }));
      void allowed;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shell tool requires confirmation for destructive commands even with grant", async () => {
    const ctx = makeCtx({
      grants: [grantFor("shell.exec")],
      interactive: true,
    });
    const answers: boolean[] = [true, false];
    const r = await registry.invoke("shell_exec", { command: "rm -rf /some/path" }, {
      ...ctx,
      confirm: async (p) => {
        ctx.confirmations.push(p.title);
        return answers.shift() ?? false;
      },
    });
    assert.ok(ctx.confirmations.some((c) => /Allow shell_exec/.test(c)), "policy consent prompt shown");
    assert.ok(ctx.confirmations.some((c) => c.includes("High-risk")), "destructive-risk prompt shown");
    assert.match(r.output, /cancelled/i);
  });

  it("policy deny blocks execution before run", async () => {
    const r = await registry.invoke(
      "web_fetch",
      { url: "https://example.com/x" },
      makeCtx({
        grants: [grantFor("network.fetch")],
        policyRules: [{ id: "deny-web", effect: "deny", enabled: true, layer: "user", conditions: { tools: ["web_fetch"] } }],
      }),
    );
    assert.equal(r.denied, "policy");
    assert.match(r.output, /Blocked by policy/);
  });

  it("fs tools stay inside project root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qo-tools2-"));
    mkdirSync(join(dir, "sub"));
    try {
      writeFileSync(join(dir, "sub", "a.txt"), "hello");
      const escaped = await registry.invoke("fs_read", { path: "../../etc/passwd" }, makeCtx({ projectRoot: dir, grants: [grantFor("fs.read")] }));
      assert.equal(escaped.ok, false);
      assert.match(escaped.output, /failed|outside|Error/i);
      const inside = await registry.invoke("fs_read", { path: "sub/a.txt" }, makeCtx({ projectRoot: dir, grants: [grantFor("fs.read")] }));
      assert.equal(inside.ok, true);
      assert.equal(inside.output.startsWith("hello"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomic edit refuses ambiguous snippets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qo-tools3-"));
    try {
      writeFileSync(join(dir, "dup.txt"), "x\ny\nx\n");
      const r = await registry.invoke("fs_edit", { path: "dup.txt", oldText: "x", newText: "z" }, makeCtx({ projectRoot: dir, grants: [grantFor("fs.write")], interactive: false, policyRules: [{ id: "allow-write", effect: "allow", enabled: true, layer: "user", conditions: { permissions: ["fs.write"] } }] }));
      assert.equal(r.ok, false);
      assert.match(r.output, /ambiguous/);
      const content = await import("node:fs/promises").then((m) => m.readFile(join(dir, "dup.txt"), "utf8"));
      assert.equal(content, "x\ny\nx\n"); // unchanged on refusal (#NO SILENT DESTRUCTION)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("safe arithmetic evaluator", () => {
  it("handles precedence and functions without eval", () => {
    assert.equal(evaluateArithmetic("2+3*4"), 14);
    assert.equal(evaluateArithmetic("(2+3)*4"), 20);
    assert.equal(evaluateArithmetic("2^10"), 1024);
    assert.equal(evaluateArithmetic("sqrt(81)+max(1,5,3)"), 14);
    assert.throws(() => evaluateArithmetic("process.exit(1)"));
    assert.throws(() => evaluateArithmetic("1/0"));
    assert.throws(() => evaluateArithmetic("__proto__"));
  });
});

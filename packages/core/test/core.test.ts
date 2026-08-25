import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ErrorCode, QofenoError } from "../src/errors.js";
import { s } from "../src/schema.js";
import { evaluateRules, newGrant, type DenyRule, type PermissionGrant } from "../src/permissions.js";
import { RulePolicyEngine, type PolicyInput, type PolicyRule } from "../src/policy.js";

describe("schema", () => {
  it("validates strictly with paths", () => {
    const schema = s.object({ name: s.string({ min: 1, max: 4 }) }, { strict: true });
    assert.throws(
      () => schema.parse({ name: "", extra: 1 }),
      (e: unknown) => {
        const err = e as QofenoError;
        assert.equal(err.code, ErrorCode.VALIDATION_FAILED);
        assert.ok(err.issues!.some((i) => i.path.includes("name")));
        assert.ok(err.issues!.some((i) => i.path.includes("extra")));
        return true;
      },
    );
  });

  it("infers union output across members", () => {
    const u = s.union(
      s.object({ kind: s.literal("a"), x: s.string() }, { strict: true }),
      s.object({ kind: s.literal("b"), y: s.number() }, { strict: true }),
    );
    assert.deepEqual(u.parse({ kind: "b", y: 2 }), { kind: "b", y: 2 });
    assert.throws(() => u.parse({ kind: "c", z: 1 }));
  });

  it("enforces array bounds and optional fields", () => {
    const arr = s.array(s.string(), { max: 2 });
    assert.equal(arr.parse(["a"]).length, 1);
    assert.throws(() => arr.parse(["a", "b", "c"]));
    const obj = s.object({ maybe: s.string().optional() }, { strict: true });
    assert.deepEqual(obj.parse({}), {});
  });
});

describe("permission rules", () => {
  const grant = (p: Partial<PermissionGrant>): PermissionGrant =>
    newGrant({
      permission: "shell.exec",
      scope: { kind: "always" },
      decision: "allow-session",
      source: "user-prompt",
      ...p,
    });

  it("exact deny beats allow regardless of order", () => {
    const g = grant({});
    const d: DenyRule = { id: "d1", permission: "shell.exec", pattern: "rm ", createdAtMs: 0, source: "user-prompt" };
    const mk = (): Parameters<typeof evaluateRules>[0] => [
      { isDeny: true as const, deny: d },
      { isDeny: false as const, grant: g },
    ];
    assert.equal(evaluateRules(mk(), { permission: "shell.exec", target: "rm -rf /" }).allowed, false);
    assert.equal(evaluateRules(mk().reverse(), { permission: "shell.exec", target: "rm -rf /" }).allowed, false);
    // Non-matching deny pattern falls through to the grant.
    const ok = evaluateRules(mk(), { permission: "shell.exec", target: "ls -la" });
    assert.equal(ok.allowed, true);
  });

  it("pattern grants match prefix targets only", () => {
    const g = grant({ scope: { kind: "pattern", pattern: "npm test" } });
    assert.equal(
      evaluateRules([{ isDeny: false, grant: g }], { permission: "shell.exec", target: "npm test -- --watch" }).allowed,
      true,
    );
    assert.equal(
      evaluateRules([{ isDeny: false, grant: g }], { permission: "shell.exec", target: "npm publish" }).allowed,
      false,
    );
  });

  it("project-scoped grants do not leak to other projects", () => {
    const g = grant({ scope: { kind: "project", projectRoot: "/work/a" } });
    assert.equal(
      evaluateRules([{ isDeny: false, grant: g }], { permission: "shell.exec", projectRoot: "/work/a" }).allowed,
      true,
    );
    assert.equal(
      evaluateRules([{ isDeny: false, grant: g }], { permission: "shell.exec", projectRoot: "/work/b" }).allowed,
      false,
    );
  });
});

describe("policy engine", () => {
  const engine = new RulePolicyEngine();
  const input: PolicyInput = {
    action: "tool.invoke",
    toolId: "shell",
    permission: "shell.exec",
    classification: "private",
    workspaceTrusted: true,
    interactive: false,
  };

  it("defaults to deny without matching rules in non-interactive mode", async () => {
    const d = await engine.evaluate([], input);
    assert.equal(d.effect, "deny");
  });

  it("confirm wins over allow; deny wins over confirm", async () => {
    const rules: PolicyRule[] = [
      { id: "r-allow", effect: "allow", enabled: true, layer: "user", conditions: {} },
      { id: "r-confirm", effect: "confirm", enabled: true, layer: "user", conditions: { tools: ["shell"] } },
    ];
    assert.equal((await engine.evaluate(rules, input)).effect, "confirm");
    rules.push({
      id: "r-deny",
      effect: "deny",
      enabled: true,
      layer: "built-in",
      conditions: { permissions: ["package.install"] },
    });
    assert.equal((await engine.evaluate(rules, input)).effect, "confirm");
    assert.equal(
      (
        await engine.evaluate(rules, {
          ...input,
          permission: "package.install",
          toolId: "pkg.install",
        })
      ).effect,
      "deny",
    );
  });

  it("untrusted-workspace-only rules apply only in untrusted workspaces", async () => {
    const rules: PolicyRule[] = [
      {
        id: "untrusted-confirm",
        effect: "confirm",
        enabled: true,
        layer: "built-in",
        conditions: { untrustedWorkspaceOnly: true },
      },
    ];
    assert.equal((await engine.evaluate(rules, input)).effect, "deny");
    assert.equal((await engine.evaluate(rules, { ...input, workspaceTrusted: false })).effect, "confirm");
  });
});

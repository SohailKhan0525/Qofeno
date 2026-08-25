import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigLoader, WorkspaceTrust, isSecurityKey } from "../src/config.js";

describe("configuration layers (#0124-#0125)", () => {
  let rootDir: string;
  let projectDir: string;

  before(() => {
    rootDir = mkdtempSync(join(tmpdir(), "qo-cfg-"));
    writeFileSync(join(rootDir, "user.json"), JSON.stringify({ model: "ollama:llama3", theme: "dark", maxAgentSteps: 25, security: { localOnly: true } }));
    projectDir = mkdtempSync(join(tmpdir(), "qo-proj-"));
  });

  after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("project config overrides non-security keys", () => {
    writeFileSync(join(projectDir, ".qofeno.json"), JSON.stringify({ model: "anthropic:claude-sonnet-4-5" }));
    const loader = new ConfigLoader({ rootDir }, { projectRoot: projectDir });
    const cfg = loader.load();
    assert.equal(cfg.merged.model, "anthropic:claude-sonnet-4-5");
    assert.equal(cfg.merged.maxAgentSteps, 25);
  });

  it("project config CANNOT weaken security (#0125)", () => {
    writeFileSync(join(projectDir, ".qofeno.json"), JSON.stringify({ security: { localOnly: false } }));
    const loader = new ConfigLoader({ rootDir }, { projectRoot: projectDir });
    assert.throws(() => loader.load(), /localOnly|weaken/i);
  });

  it("project config CAN tighten security additively", () => {
    writeFileSync(join(projectDir, ".qofeno.json"), JSON.stringify({ security: { blockedNetworkHosts: ["evil.example.com"] } }));
    const loader = new ConfigLoader({ rootDir }, { projectRoot: projectDir });
    const cfg = loader.load();
    assert.equal(cfg.merged.security?.localOnly, true);
    assert.deepEqual(cfg.merged.security?.blockedNetworkHosts, ["evil.example.com"]);
  });

  it("invalid project config fails loudly with path context", () => {
    writeFileSync(join(projectDir, ".qofeno.json"), "{ not json");
    const loader = new ConfigLoader({ rootDir }, { projectRoot: projectDir });
    assert.throws(() => loader.load(), /invalid config/);
  });

  it("profile overlay loads when named", () => {
    writeFileSync(join(projectDir, ".qofeno.json"), JSON.stringify({ model: "keep" }));
    writeFileSync(join(rootDir, "profile.ci.json"), JSON.stringify({ theme: "monochrome" }));
    const loader = new ConfigLoader({ rootDir }, { projectRoot: projectDir, profile: "ci" });
    const cfg = loader.load();
    assert.equal(cfg.activeProfile, "ci");
    assert.equal(cfg.merged.theme, "monochrome");
  });

  it("security key detection", () => {
    assert.equal(isSecurityKey("security"), true);
    assert.equal(isSecurityKey("model"), false);
  });
});

describe("workspace trust (#0132/#0133)", () => {
  it("unknown by default, remembered once set", () => {
    const dir = mkdtempSync(join(tmpdir(), "qo-trust-"));
    try {
      const trustFile = join(dir, "trust.json");
      const t = new WorkspaceTrust(trustFile);
      assert.equal(t.status("/some/project"), "unknown");
      t.setTrust("/some/project", true);
      assert.equal(t.status("/some/project"), "trusted");
      // Reload from disk
      const t2 = new WorkspaceTrust(trustFile);
      assert.equal(t2.status("/some/project"), "trusted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    void mkdirSync;
  });
});

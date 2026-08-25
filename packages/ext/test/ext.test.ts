import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHost, extensionManifestSchema, McpStdioClient } from "../src/host.js";

describe("extension manifest validation (#0064)", () => {
  it("accepts a valid manifest", () => {
    const m = extensionManifestSchema.parse({
      id: "my-ext",
      name: "My Extension",
      version: "1.0.0",
      apiVersion: 1,
      permissions: ["fs.read"],
      provides: [{ kind: "command", ref: "./cmd.js", name: "hello" }],
    });
    assert.equal(m.id, "my-ext");
  });

  it("rejects bad ids, wrong apiVersion and unknown fields", () => {
    assert.throws(() =>
      extensionManifestSchema.parse({ id: "BAD ID", name: "x", version: "1", apiVersion: 1, permissions: [], provides: [] }),
    );
    assert.throws(() =>
      extensionManifestSchema.parse({ id: "ok-id", name: "x", version: "1", apiVersion: 2, permissions: [], provides: [] }),
    );
    assert.throws(() =>
      extensionManifestSchema.parse({ id: "ok-id", name: "x", version: "1", apiVersion: 1, permissions: [], provides: [], sneaky: true }),
    );
  });

  it("installFromDirectory validates untrusted files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qo-ext-"));
    try {
      const extDir = join(dir, "good");
      mkdirSync(extDir);
      writeFileSync(
        join(extDir, "manifest.json"),
        JSON.stringify({ id: "good-ext", name: "Good", version: "0.1.0", apiVersion: 1, permissions: ["network.fetch"], provides: [] }),
      );
      const host = new ExtensionHost(dir);
      const rec = await host.installFromDirectory(extDir);
      assert.equal(rec.trusted, false);
      assert.equal(rec.enabled, false);

      const badDir = join(dir, "bad");
      mkdirSync(badDir);
      writeFileSync(join(badDir, "manifest.json"), "{ nope");
      await assert.rejects(() => host.installFromDirectory(badDir), /not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP stdio client against a real in-process server script", () => {
  it("lists tools and calls one over JSON-RPC 2.0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qo-mcp-"));
    const serverScript = join(dir, "server.mjs");
    writeFileSync(
      serverScript,
      `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: [] } }
    ] } }) + "\\n");
  } else if (msg.method === "tools/call") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + (msg.params.arguments?.text ?? "") }] } }) + "\\n");
  }
});`,
    );
    try {
      const client = new McpStdioClient({ name: "test", command: process.execPath, args: [serverScript] });
      const tools = await client.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0]!.name, "echo");
      const out = await client.callTool("echo", { text: "hello" });
      assert.equal(out, "echo:hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

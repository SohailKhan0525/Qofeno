import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, ID } from "@agent-qofeno/core";
import { SqliteStorage } from "../src/sqlite.js";

describe("sqlite storage", () => {
  let store: SqliteStorage;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "qo-store-"));
    store = new SqliteStorage({ dataDir: dir });
    await store.init();
  });

  after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies migrations once and reports health", async () => {
    const h = await store.healthCheck();
    assert.equal(h.ok, true);
  });

  it("stores and searches sessions via message FTS", async () => {
    const s1 = newId(ID.session);
    await store.createSession({ id: s1, title: "Fix login bug", projectRoot: "/work/app", createdAtMs: Date.now(), updatedAtMs: Date.now(), mode: "normal" });
    const s2 = newId(ID.session);
    await store.createSession({ id: s2, title: "Refactor parser", createdAtMs: Date.now(), updatedAtMs: Date.now(), mode: "plan" });
    const msg = (sessionId: string, content: string) =>
      store.appendMessage({ id: newId(ID.message), sessionId, parentId: null, role: "user", content, status: "completed", createdAtMs: Date.now() });
    await msg(s1, "The oauth callback returns 401 after redirect");
    await msg(s2, "Tokenizer needs unicode awareness");

    const found = await store.searchSessions("oauth 401");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, s1);
    const none = await store.searchSessions("kubernetes ingress");
    assert.equal(none.length, 0);
  });

  it("message lineage follows parent chain", async () => {
    const sid = newId(ID.session);
    await store.createSession({ id: sid, title: "t", createdAtMs: 1, updatedAtMs: 1, mode: "normal" });
    const a = newId(ID.message);
    const b = newId(ID.message);
    const c = newId(ID.message);
    await store.appendMessage({ id: a, sessionId: sid, parentId: null, role: "user", content: "a", status: "completed", createdAtMs: 1 });
    await store.appendMessage({ id: b, sessionId: sid, parentId: a, role: "assistant", content: "b", status: "completed", createdAtMs: 2 });
    // Branch: c is a sibling edit of b
    await store.appendMessage({ id: c, sessionId: sid, parentId: a, role: "user", content: "c-branch", status: "completed", createdAtMs: 3 });
    const line = await store.lineage(sid, b);
    assert.deepEqual(line.map((m) => m.id), [a, b]);
    const lineC = await store.lineage(sid, c);
    assert.deepEqual(lineC.map((m) => m.id), [a, c]);
  });

  it("memory scoping filters by project with global included", async () => {
    await store.addMemory({ id: newId(ID.memory), content: "global pref", scope: "global", provenance: "user", createdAtMs: Date.now(), classification: "private" });
    await store.addMemory({ id: newId(ID.memory), content: "app uses pnpm", scope: "project", projectRoot: "/work/app", provenance: "conversation", createdAtMs: Date.now(), classification: "private" });
    const scoped = await store.listMemories({ projectRoot: "/work/app" });
    assert.equal(scoped.length, 2);
    const other = await store.listMemories({ projectRoot: "/other" });
    assert.equal(other.length, 1);
    assert.equal(other[0]!.scope, "global");
  });

  it("knowledge keyword search with chunk replacement", async () => {
    const cid = newId(ID.knowledgeCollection);
    await store.createCollection({ id: cid, name: "docs", classification: "private", createdAtMs: Date.now() });
    const srcId = newId(ID.knowledgeSource);
    await store.upsertSource({ id: srcId, collectionId: cid, kind: "text", title: "notes.txt", sizeBytes: 100, sha256: "abc", indexState: "indexed", chunkCount: 2 });
    await store.replaceChunks(srcId, [
      { sourceId: srcId, collectionId: cid, ordinal: 0, text: "The deployment pipeline uses blue-green strategy", startChar: 0, endChar: 48 },
      { sourceId: srcId, collectionId: cid, ordinal: 1, text: "Rollbacks are automated within five minutes", startChar: 49, endChar: 92 },
    ]);
    const hits = await store.keywordSearch([cid], "rollback automation", 5);
    assert.ok(hits.length >= 1);
    assert.ok(hits[0]!.chunk.text.includes("automated"));
    // Replacement clears old chunks (duplicate handling #0177)
    await store.replaceChunks(srcId, [
      { sourceId: srcId, collectionId: cid, ordinal: 0, text: "unrelated content now", startChar: 0, endChar: 21 },
    ]);
    const stale = await store.keywordSearch([cid], "blue-green", 5);
    assert.equal(stale.length, 0);
  });

  it("grant/deny persistence roundtrip", async () => {
    const gid = newId(ID.grant);
    await store.addGrant({ id: gid, permission: "shell.exec", scope: { kind: "pattern", pattern: "npm test" }, decision: "allow-session", source: "user-prompt", createdAtMs: Date.now() });
    let grants = await store.listGrants();
    assert.ok(grants.some((g) => g.id === gid));
    await store.revokeGrant(gid);
    grants = await store.listGrants();
    assert.ok(!grants.some((g) => g.id === gid));
  });

  it("audit records append-only", async () => {
    store.audit({ action: "tool.invoke", targetType: "tool", targetId: "shell", decision: "allowed", atMs: Date.now() });
    const rows = await store.listAudit(10);
    assert.ok(rows.some((r) => r.action === "tool.invoke"));
  });

  it("blob store roundtrips bytes with integrity metadata", async () => {
    const data = new Uint8Array(Buffer.from("binary payload \u0000 with nul"));
    const meta = await store.blobs.put(data, { mime: "application/octet-stream" });
    assert.equal(meta.sizeBytes, data.byteLength);
    const got = await store.blobs.get(meta.ref);
    assert.ok(got);
    assert.deepEqual(Buffer.from(got.bytes).equals(Buffer.from(data)), true);
    assert.match(meta.sha256, /^[a-f0-9]{64}$/);
    // Refs are validated; traversal in ref names is rejected.
    assert.equal(await store.blobs.get("../../etc/passwd"), null);
  });
});

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoIndexer } from "../src/repo.js";
import { createBackup, restoreBackup } from "../src/backup.js";
import { SqliteStorage } from "@agent-qofeno/storage";
import { KnowledgeEngine } from "@agent-qofeno/knowledge";

describe("repository intelligence (#0024-#0026)", () => {
  let store: SqliteStorage;
  let knowledge: KnowledgeEngine;
  let indexer: RepoIndexer;
  let project: string;
  let home: string;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "qo-repo-home-"));
    project = mkdtempSync(join(tmpdir(), "qo-repo-proj-"));
    writeFileSync(join(project, "auth.py"), "class Authenticator:\n    def verify(self, token):\n        return True\n");
    writeFileSync(join(project, "server.ts"), "export function startServer(port: number) {\n  return port;\n}\nexport class Router {}\n");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    writeFileSync(join(project, "node_modules", "junk.js"), "function shouldNotBeIndexed() {}\n");
    store = new SqliteStorage({ dataDir: home });
    await store.init();
    knowledge = new KnowledgeEngine(store);
    indexer = new RepoIndexer(store, knowledge);
  });

  after(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it("indexes project files while ignoring vendor dirs", async () => {
    const p = await indexer.indexProject(project);
    assert.ok(p.indexed >= 2, `indexed=${p.indexed}`);
    const hits = await indexer.searchCode(project, "startServer");
    assert.ok(hits.length >= 1);
    const vendorHits = await indexer.searchCode(project, "shouldNotBeIndexed");
    assert.equal(vendorHits.length, 0);
  });

  it("finds symbols across languages", async () => {
    const syms = await indexer.searchSymbols(project, "Authenticat");
    assert.ok(syms.some((s) => s.kind === "class" && s.file === "auth.py"));
    const fns = await indexer.searchSymbols(project, "startServer");
    assert.ok(fns.some((s) => s.kind === "function" && s.file.endsWith(".ts")));
  });
});

describe("backup / restore (#0072/#0073)", () => {
  let dataDir: string;
  let backupPath: string;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), "qo-bak-data-"));
    mkdirSync(join(dataDir, "blobs"));
    writeFileSync(join(dataDir, "qofeno.db"), "sqlite-bytes-here");
    writeFileSync(join(dataDir, "blobs", "blb_1"), "blob-content");
    writeFileSync(join(dataDir, "unrelated.txt"), "not included");
    backupPath = join(tmpdir(), `qo-backup-${Date.now()}.tar.gz`);
  });

  after(() => {
    rmSync(dataDir, { recursive: true, force: true });
    for (const f of [backupPath, `${backupPath}.manifest.json`]) if (existsSync(f)) rmSync(f);
  });

  it("creates archive + manifest with per-entry hashes; refuses overwrite", async () => {
    const manifest = await createBackup(dataDir, backupPath);
    assert.equal(manifest.format, "qofeno.backup/1");
    const paths = manifest.entries.map((e) => e.path).sort();
    assert.deepEqual(paths, ["blobs/blb_1", "qofeno.db"]);
    assert.ok(existsSync(backupPath));
    await assert.rejects(() => createBackup(dataDir, backupPath), /refusing to overwrite/);
  });

  it("restores verified bytes into a fresh dir and reports honestly", async () => {
    const target = mkdtempSync(join(tmpdir(), "qo-bak-restore-"));
    try {
      const report = await restoreBackup(backupPath, target);
      assert.equal(report.verified, 2);
      assert.ok(existsSync(join(target, "qofeno.db")));
      assert.equal(readFileSync(join(target, "blobs", "blb_1"), "utf8"), "blob-content");
      // Unrelated files are NOT restored (documented scope).
      assert.equal(existsSync(join(target, "unrelated.txt")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("fails closed on tampered archives without touching the destination", async () => {
    const tampered = `${backupPath}.tampered.tar.gz`;
    writeFileSync(tampered, readFileSync(backupPath));
    const goodManifest = JSON.parse(readFileSync(`${backupPath}.manifest.json`, "utf8"));
    const badManifest = { ...goodManifest, entries: goodManifest.entries.map((e: { sha256: string }) => ({ ...e, sha256: "0".repeat(64) })) };
    writeFileSync(`${tampered}.manifest.json`, JSON.stringify(badManifest));
    const target = mkdtempSync(join(tmpdir(), "qo-bak-tamper-"));
    try {
      await assert.rejects(() => restoreBackup(tampered, target), /integrity failure/);
      assert.equal(existsSync(join(target, "qofeno.db")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(tampered, { force: true });
      rmSync(`${tampered}.manifest.json`, { force: true });
    }
  });
});

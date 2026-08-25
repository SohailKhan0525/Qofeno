/**
 * SQLite storage adapter (#0134/#0135) built on node:sqlite.
 * - WAL journaling for crash safety (#0163)
 * - Versioned migrations with recorded history (#0136)
 * - FTS5-backed keyword indexes for sessions/messages/knowledge (#0026)
 * - Content-addressed blob store on disk
 */
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  BlobStore,
  BlobMeta,
  Storage,
  SessionRow,
  MessageRow,
  ListOptions,
} from "@agent-qofeno/core";
import type {
  MemoryRecord,
  KnowledgeCollection,
  KnowledgeSource,
  KnowledgeChunk,
  PermissionGrant,
  DenyRule,
} from "@agent-qofeno/core";

export interface StorageOptions {
  /** Directory that holds qofeno.db and blobs. Created when missing. */
  dataDir: string;
}

const MIGRATIONS: { version: number; sql: string; rollbackNote: string }[] = [
  {
    version: 1,
    rollbackNote: "v1 base schema; restore from backup to roll back",
    sql: `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_root TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  archived_at_ms INTEGER,
  deleted_at_ms INTEGER,
  model_id TEXT,
  provider_config_id TEXT,
  mode TEXT NOT NULL DEFAULT 'normal',
  compacted_from TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_call_json TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at_ms);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(content, content='messages', content_rowid='rowid', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS trg_messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO fts_messages(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS trg_messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO fts_messages(fts_messages, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('global','project','session')),
  project_root TEXT,
  session_id TEXT,
  provenance TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  classification TEXT NOT NULL DEFAULT 'private'
);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, project_root, session_id);
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_root TEXT,
  classification TEXT NOT NULL DEFAULT 'private',
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  external_url TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  index_state TEXT NOT NULL DEFAULT 'pending',
  chunk_count INTEGER NOT NULL DEFAULT 0,
  last_indexed_at_ms INTEGER,
  indexing_error TEXT
);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_char INTEGER NOT NULL DEFAULT 0,
  end_char INTEGER NOT NULL DEFAULT 0,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id, ordinal);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(text, collection_id UNINDEXED, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  permission TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  pattern TEXT,
  decision TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS denies (
  id TEXT PRIMARY KEY,
  permission TEXT NOT NULL,
  pattern TEXT,
  source TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  detail TEXT,
  at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
);
`,
  },
];

export class SqliteStorage implements Storage {
  private db!: DatabaseSync;
  readonly dataDir: string;
  private blobDir: string;

  constructor(private options: StorageOptions) {
    this.dataDir = options.dataDir;
    this.blobDir = join(this.dataDir, "blobs");
  }

  async init(): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.blobDir, { recursive: true });
    this.db = new DatabaseSync(join(this.dataDir, "qofeno.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL);");
    const applied = new Set(
      this.db.prepare("SELECT version FROM schema_migrations").all().map((r) => Number((r as Record<string, unknown>).version)),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(m.sql);
        this.db.prepare("INSERT INTO schema_migrations(version, applied_at_ms) VALUES (?, ?)").run(m.version, Date.now());
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  async close(): Promise<void> {
    this.db?.close();
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const r = this.db.prepare("SELECT count(*) AS n FROM schema_migrations").get() as Record<string, unknown>;
      return { ok: true, detail: `migrations=${r.n}` };
    } catch (e) {
      return { ok: false, detail: String(e) };
    }
  }

  // ---- Sessions -------------------------------------------------------------

  async createSession(s: SessionRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions(id,title,project_root,created_at_ms,updated_at_ms,archived_at_ms,deleted_at_ms,model_id,provider_config_id,mode,compacted_from)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(s.id, s.title, s.projectRoot ?? null, s.createdAtMs, s.updatedAtMs, s.archivedAtMs ?? null, s.deletedAtMs ?? null, s.modelId ?? null, s.providerConfigId ?? null, s.mode, s.compactedFrom ?? null);
  }

  private mapSession(r: Record<string, unknown>): SessionRow {
    return {
      id: r.id as string,
      title: r.title as string,
      projectRoot: (r.project_root as string | null) ?? undefined,
      createdAtMs: r.created_at_ms as number,
      updatedAtMs: r.updated_at_ms as number,
      archivedAtMs: (r.archived_at_ms as number | null) ?? undefined,
      deletedAtMs: (r.deleted_at_ms as number | null) ?? undefined,
      modelId: (r.model_id as string | null) ?? undefined,
      providerConfigId: (r.provider_config_id as string | null) ?? undefined,
      mode: r.mode as string,
      compactedFrom: (r.compacted_from as string | null) ?? undefined,
    };
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? this.mapSession(r) : null;
  }

  async updateSession(s: SessionRow): Promise<void> {
    this.db
      .prepare(
        `UPDATE sessions SET title=?, project_root=?, updated_at_ms=?, archived_at_ms=?, deleted_at_ms=?, model_id=?, provider_config_id=?, mode=?, compacted_from=? WHERE id=?`,
      )
      .run(s.title, s.projectRoot ?? null, s.updatedAtMs, s.archivedAtMs ?? null, s.deletedAtMs ?? null, s.modelId ?? null, s.providerConfigId ?? null, s.mode, s.compactedFrom ?? null, s.id);
  }

  async listSessions(opts: { includeArchived?: boolean; includeDeleted?: boolean; projectRoot?: string } & ListOptions = {}): Promise<SessionRow[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (!opts.includeArchived) clauses.push("archived_at_ms IS NULL");
    if (!opts.includeDeleted) clauses.push("deleted_at_ms IS NULL");
    if (opts.projectRoot !== undefined) {
      clauses.push("project_root = ?");
      params.push(opts.projectRoot);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at_ms DESC LIMIT ?`)
      .all(...params, limit) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.mapSession(r));
  }

  async searchSessions(query: string, limit = 20): Promise<SessionRow[]> {
    // Sessions are searched through their messages' full-text index.
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.* FROM sessions s JOIN messages m ON m.session_id = s.id
         WHERE m.rowid IN (SELECT rowid FROM fts_messages WHERE fts_messages MATCH ? LIMIT 200)
           AND s.deleted_at_ms IS NULL
         ORDER BY s.updated_at_ms DESC LIMIT ?`,
      )
      .all(...ftsQuery(query), limit) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.mapSession(r));
  }

  // ---- Messages ---------------------------------------------------------------

  async appendMessage(m: MessageRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages(id,session_id,parent_id,role,content,tool_name,tool_call_json,status,created_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(m.id, m.sessionId, m.parentId ?? null, m.role, m.content, m.toolName ?? null, m.toolCallJson ?? null, m.status, m.createdAtMs);
    this.db.prepare("UPDATE sessions SET updated_at_ms=? WHERE id=?").run(m.createdAtMs, m.sessionId);
  }

  private mapMessage(r: Record<string, unknown>): MessageRow {
    return {
      id: r.id as string,
      sessionId: r.session_id as string,
      parentId: (r.parent_id as string | null) ?? null,
      role: r.role as MessageRow["role"],
      content: r.content as string,
      toolName: (r.tool_name as string | null) ?? undefined,
      toolCallJson: (r.tool_call_json as string | null) ?? undefined,
      status: r.status as string,
      createdAtMs: r.created_at_ms as number,
    };
  }

  async getMessage(id: string): Promise<MessageRow | null> {
    const r = this.db.prepare("SELECT * FROM messages WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? this.mapMessage(r) : null;
  }

  async updateMessage(m: MessageRow): Promise<void> {
    this.db
      .prepare(`UPDATE messages SET content=?, status=?, tool_call_json=? WHERE id=?`)
      .run(m.content, m.status, m.toolCallJson ?? null, m.id);
  }

  async listMessages(sessionId: string, opts: ListOptions = {}): Promise<MessageRow[]> {
    const limit = opts.limit ?? 500;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE session_id=? ORDER BY created_at_ms ASC LIMIT ? OFFSET ?")
      .all(sessionId, limit, offset) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.mapMessage(r));
  }

  async lineage(sessionId: string, leafId: string): Promise<MessageRow[]> {
    // Walk parent links from the leaf to the root.
    const byId = new Map<string, MessageRow>();
    const chain: MessageRow[] = [];
    let cursor: string | null = leafId;
    while (cursor) {
      let m = byId.get(cursor);
      if (!m) {
        const got = await this.getMessage(cursor);
        if (!got || got.sessionId !== sessionId) break;
        byId.set(cursor, got);
        m = got;
      }
      chain.unshift(m);
      cursor = m.parentId;
    }
    return chain;
  }

  async searchMessages(query: string, opts: { sessionId?: string; limit?: number } = {}): Promise<MessageRow[]> {
    const args = ftsQuery(query);
    if (opts.sessionId) {
      const rows = this.db
        .prepare(
          `SELECT m.* FROM messages m JOIN fts_messages f ON f.rowid = m.rowid
           WHERE fts_messages MATCH ? AND m.session_id = ? ORDER BY rank LIMIT ?`,
        )
        .all(args[0], opts.sessionId, opts.limit ?? 20) as unknown as Record<string, unknown>[];
      return rows.map((r) => this.mapMessage(r));
    }
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN fts_messages f ON f.rowid = m.rowid
         WHERE fts_messages MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(args[0], opts.limit ?? 20) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.mapMessage(r));
  }

  // ---- Memory --------------------------------------------------------------------

  async addMemory(m: MemoryRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO memories(id,content,scope,project_root,session_id,provenance,created_at_ms,expires_at_ms,classification)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(m.id, m.content, m.scope, m.projectRoot ?? null, m.sessionId ?? null, m.provenance, m.createdAtMs, m.expiresAtMs ?? null, m.classification);
  }

  private mapMemory(r: Record<string, unknown>): MemoryRecord {
    return {
      id: r.id as string,
      content: r.content as string,
      scope: r.scope as MemoryRecord["scope"],
      projectRoot: (r.project_root as string | null) ?? undefined,
      sessionId: (r.session_id as string | null) ?? undefined,
      provenance: r.provenance as MemoryRecord["provenance"],
      createdAtMs: r.created_at_ms as number,
      expiresAtMs: (r.expires_at_ms as number | null) ?? undefined,
      classification: r.classification as DataClassificationStr,
    };
  }

  async getMemory(id: string): Promise<MemoryRecord | null> {
    const r = this.db.prepare("SELECT * FROM memories WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? this.mapMemory(r) : null;
  }

  async updateMemory(m: MemoryRecord): Promise<void> {
    this.db
      .prepare(`UPDATE memories SET content=?, classification=?, expires_at_ms=? WHERE id=?`)
      .run(m.content, m.classification, m.expiresAtMs ?? null, m.id);
  }

  async deleteMemory(id: string): Promise<void> {
    this.db.prepare("DELETE FROM memories WHERE id=?").run(id);
  }

  async clearMemories(scope: { projectRoot?: string } = {}): Promise<number> {
    if (scope.projectRoot !== undefined) {
      const info = this.db.prepare("DELETE FROM memories WHERE project_root=? OR scope='global'").run(scope.projectRoot);
      return Number(info.changes);
    }
    const info = this.db.prepare("DELETE FROM memories").run();
    return Number(info.changes);
  }

  async listMemories(opts: { projectRoot?: string; includeGlobal?: boolean } & ListOptions = {}): Promise<MemoryRecord[]> {
    const now = Date.now();
    const clauses: string[] = ["(expires_at_ms IS NULL OR expires_at_ms > ?)"];
    const params: (string | number)[] = [now];
    if (opts.projectRoot !== undefined && !opts.includeGlobal) {
      clauses.push("(scope='global' OR (scope='project' AND project_root=?))");
      params.push(opts.projectRoot);
    } else if (opts.projectRoot === undefined) {
      clauses.push("scope='global'");
    }
    const limit = opts.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY created_at_ms DESC LIMIT ?`)
      .all(...params, limit) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.mapMemory(r));
  }

  // ---- Knowledge ---------------------------------------------------------------

  async createCollection(c: KnowledgeCollection): Promise<void> {
    this.db
      .prepare("INSERT INTO collections(id,name,project_root,classification,created_at_ms) VALUES (?,?,?,?,?)")
      .run(c.id, c.name, c.projectRoot ?? null, c.classification, c.createdAtMs);
  }

  private mapCollection(r: Record<string, unknown>): KnowledgeCollection {
    return {
      id: r.id as string,
      name: r.name as string,
      projectRoot: (r.project_root as string | null) ?? undefined,
      classification: r.classification as DataClassificationStr,
      createdAtMs: r.created_at_ms as number,
    };
  }

  async getCollection(id: string): Promise<KnowledgeCollection | null> {
    const r = this.db.prepare("SELECT * FROM collections WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? this.mapCollection(r) : null;
  }

  async listCollections(projectRoot?: string): Promise<KnowledgeCollection[]> {
    const rows =
      projectRoot !== undefined
        ? (this.db.prepare("SELECT * FROM collections WHERE project_root=? OR project_root IS NULL ORDER BY created_at_ms DESC").all(projectRoot) as unknown as Record<string, unknown>[])
        : (this.db.prepare("SELECT * FROM collections ORDER BY created_at_ms DESC").all() as unknown as Record<string, unknown>[]);
    return rows.map((r) => this.mapCollection(r));
  }

  async deleteCollection(id: string): Promise<void> {
    const sources = this.db.prepare("SELECT id FROM sources WHERE collection_id=?").all(id) as unknown as Record<string, unknown>[];
    for (const s of sources) await this.deleteSource(s.id as string);
    this.db.prepare("DELETE FROM collections WHERE id=?").run(id);
  }

  async upsertSource(src: KnowledgeSource): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sources(id,collection_id,kind,title,external_url,size_bytes,sha256,index_state,chunk_count,last_indexed_at_ms,indexing_error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,external_url=excluded.external_url,
           size_bytes=excluded.size_bytes,sha256=excluded.sha256,index_state=excluded.index_state,
           chunk_count=excluded.chunk_count,last_indexed_at_ms=excluded.last_indexed_at_ms,indexing_error=excluded.indexing_error`,
      )
      .run(src.id, src.collectionId, src.kind, src.title, src.externalUrl ?? null, src.sizeBytes, src.sha256, src.indexState, src.chunkCount, src.lastIndexedAtMs ?? null, src.indexingError ?? null);
  }

  private mapSource(r: Record<string, unknown>): KnowledgeSource {
    return {
      id: r.id as string,
      collectionId: r.collection_id as string,
      kind: r.kind as KnowledgeSource["kind"],
      title: r.title as string,
      externalUrl: (r.external_url as string | null) ?? undefined,
      sizeBytes: r.size_bytes as number,
      sha256: r.sha256 as string,
      indexState: r.index_state as KnowledgeSource["indexState"],
      chunkCount: r.chunk_count as number,
      lastIndexedAtMs: (r.last_indexed_at_ms as number | null) ?? undefined,
      indexingError: (r.indexing_error as string | null) ?? undefined,
    };
  }

  async getSource(id: string): Promise<KnowledgeSource | null> {
    const r = this.db.prepare("SELECT * FROM sources WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return r ? this.mapSource(r) : null;
  }

  async findSourceByHash(collectionId: string, sha256: string): Promise<KnowledgeSource | null> {
    const r = this.db
      .prepare("SELECT * FROM sources WHERE collection_id=? AND sha256=? LIMIT 1")
      .get(collectionId, sha256) as Record<string, unknown> | undefined;
    return r ? this.mapSource(r) : null;
  }

  async listSources(collectionId: string): Promise<KnowledgeSource[]> {
    const rows = this.db.prepare("SELECT * FROM sources WHERE collection_id=? ORDER BY title").all(collectionId) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.mapSource(r));
  }

  async deleteSource(id: string): Promise<void> {
    this.db.prepare("DELETE FROM chunks WHERE source_id=?").run(id);
    this.db.prepare("DELETE FROM sources WHERE id=?").run(id);
  }

  async replaceChunks(sourceId: string, chunks: Omit<KnowledgeChunk, "id">[]): Promise<void> {
    // Resolve the owning collection up front so the FTS mirror can be fully rebuilt.
    const srcRow = this.db.prepare("SELECT collection_id FROM sources WHERE id=?").get(sourceId) as Record<string, unknown> | undefined;
    const collId = (chunks[0]?.collectionId ?? (srcRow?.collection_id as string | undefined)) ?? null;
    this.db.prepare("DELETE FROM chunks WHERE source_id=?").run(sourceId);
    if (!collId) return;
    const insert = this.db.prepare(
      "INSERT INTO chunks(id,source_id,collection_id,ordinal,text,start_char,end_char,embedding) VALUES (?,?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      const emb = c.embedding ? Buffer.from(new Float32Array(c.embedding).buffer) : null;
      insert.run(`${sourceId}:${i}`, sourceId, c.collectionId, c.ordinal, c.text, c.startChar, c.endChar, emb);
    }
    this.rebuildFtsForCollection(collId);
  }

  /** Rebuild the FTS mirror for a collection deterministically (no stale terms). */
  private rebuildFtsForCollection(collectionId: string): void {
    this.db.prepare("DELETE FROM fts_chunks WHERE collection_id=?").run(collectionId);
    const all = this.db
      .prepare(
        "SELECT ch.rowid AS rid, ch.text AS text FROM chunks ch JOIN sources s ON s.id=ch.source_id WHERE s.collection_id=?",
      )
      .all(collectionId) as unknown as Array<{ rid: number; text: string }>;
    for (const row of all) {
      this.db.prepare("INSERT INTO fts_chunks(rowid, text, collection_id) VALUES (?, ?, ?)").run(row.rid, row.text, collectionId);
    }
  }

  private mapChunk(r: Record<string, unknown>): KnowledgeChunk {
    const emb = r.embedding as Buffer | null;
    return {
      id: r.id as string,
      sourceId: r.source_id as string,
      collectionId: r.collection_id as string,
      ordinal: r.ordinal as number,
      text: r.text as string,
      startChar: r.start_char as number,
      endChar: r.end_char as number,
      ...(emb ? { embedding: Array.from(new Float32Array(emb.buffer, emb.byteOffset, Math.floor(emb.byteLength / 4))) } : {}),
    };
  }

  async chunksForCollection(collectionId: string): Promise<KnowledgeChunk[]> {
    const rows = this.db
      .prepare(
        "SELECT c.*, s.collection_id AS cid2 FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.collection_id=? ORDER BY c.source_id, c.ordinal",
      )
      .all(collectionId) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({ ...this.mapChunk({ ...r, collection_id: r.cid2 }) }));
  }

  async keywordSearch(
    collectionIds: string[],
    query: string,
    limit: number,
  ): Promise<Array<{ chunk: KnowledgeChunk; score: number }>> {
    if (collectionIds.length === 0) return [];
    const placeholders = collectionIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT ch.*, bm25(fts_chunks) AS score FROM fts_chunks f
         JOIN chunks ch ON ch.rowid = f.rowid
         WHERE fts_chunks MATCH ? AND f.collection_id IN (${placeholders})
         ORDER BY score LIMIT ?`,
      )
      .all(ftsQuery(query)[0], ...collectionIds, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({ chunk: this.mapChunk(r), score: -(r.score as number) }));
  }

  async allEmbeddings(collectionIds: string[]): Promise<Array<{ chunk: KnowledgeChunk; embedding: number[] }>> {
    if (collectionIds.length === 0) return [];
    const placeholders = collectionIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT ch.* FROM chunks ch JOIN sources s ON s.id=ch.source_id
         WHERE s.collection_id IN (${placeholders}) AND ch.embedding IS NOT NULL`,
      )
      .all(...collectionIds) as unknown as Array<Record<string, unknown>>;
    const out: Array<{ chunk: KnowledgeChunk; embedding: number[] }> = [];
    for (const r of rows) {
      const c = this.mapChunk(r);
      if (c.embedding) out.push({ chunk: c, embedding: c.embedding });
    }
    return out;
  }

  // ---- Permissions ----------------------------------------------------------------

  async addGrant(g: PermissionGrant): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO grants(id,permission,scope_json,pattern,decision,source,created_at_ms) VALUES (?,?,?,?,?,?,?)")
      .run(g.id, g.permission, JSON.stringify(g.scope), g.pattern ?? null, g.decision, g.source, g.createdAtMs);
  }

  async revokeGrant(id: string): Promise<void> {
    this.db.prepare("DELETE FROM grants WHERE id=?").run(id);
  }

  async listGrants(): Promise<PermissionGrant[]> {
    const rows = this.db.prepare("SELECT * FROM grants ORDER BY created_at_ms DESC").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      permission: r.permission as PermissionGrant["permission"],
      scope: JSON.parse(r.scope_json as string),
      pattern: (r.pattern as string | null) ?? undefined,
      decision: r.decision as PermissionGrant["decision"],
      source: r.source as PermissionGrant["source"],
      createdAtMs: r.created_at_ms as number,
    }));
  }

  async addDeny(d: DenyRule): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO denies(id,permission,pattern,source,created_at_ms) VALUES (?,?,?,?,?)").run(d.id, d.permission, d.pattern ?? null, d.source, d.createdAtMs);
  }

  async listDenies(): Promise<DenyRule[]> {
    const rows = this.db.prepare("SELECT * FROM denies ORDER BY created_at_ms DESC").all() as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      permission: r.permission as DenyRule["permission"],
      pattern: (r.pattern as string | null) ?? undefined,
      source: r.source as DenyRule["source"],
      createdAtMs: r.created_at_ms as number,
    }));
  }

  async removeDeny(id: string): Promise<void> {
    this.db.prepare("DELETE FROM denies WHERE id=?").run(id);
  }

  // ---- Audit / settings -----------------------------------------------------------

  audit(record: { action: string; targetType: string; targetId: string; decision: string; detail?: string; atMs: number }): void {
    this.db
      .prepare("INSERT INTO audit(action,target_type,target_id,decision,detail,at_ms) VALUES (?,?,?,?,?,?)")
      .run(record.action, record.targetType, record.targetId, record.decision, record.detail ?? null, record.atMs);
  }

  async listAudit(limit: number): Promise<Array<{ id: string; action: string; targetType: string; targetId: string; decision: string; detail?: string; atMs: number }>> {
    const rows = this.db.prepare("SELECT * FROM audit ORDER BY at_ms DESC LIMIT ?").all(limit) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      action: r.action as string,
      targetType: r.target_type as string,
      targetId: r.target_id as string,
      decision: r.decision as string,
      detail: (r.detail as string | null) ?? undefined,
      atMs: r.at_ms as number,
    }));
  }

  async getSetting(namespace: string, key: string): Promise<string | null> {
    const r = this.db.prepare("SELECT value FROM settings WHERE namespace=? AND key=?").get(namespace, key) as Record<string, unknown> | undefined;
    return r ? (r.value as string) : null;
  }

  async setSetting(namespace: string, key: string, value: string): Promise<void> {
    this.db.prepare("INSERT INTO settings(namespace,key,value) VALUES (?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value").run(namespace, key, value);
  }

  async deleteSetting(namespace: string, key: string): Promise<void> {
    this.db.prepare("DELETE FROM settings WHERE namespace=? AND key=?").run(namespace, key);
  }

  async listSettings(namespace: string): Promise<Record<string, string>> {
    const rows = this.db.prepare("SELECT key,value FROM settings WHERE namespace=?").all(namespace) as unknown as Array<Record<string, unknown>>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key as string] = r.value as string;
    return out;
  }

  // ---- Blobs ---------------------------------------------------------

  readonly blobs: BlobStore = {
    put: async (bytes, meta) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const ref = `blb_${sha256.slice(0, 32)}_${randomBytes(4).toString("hex")}`;
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(this.blobDir, ref), bytes, { mode: 0o600 });
      const blobMeta: BlobMeta = { ref, sizeBytes: bytes.byteLength, sha256, mime: meta.mime, createdAtMs: Date.now() };
      await this.setSetting("blobs", ref, JSON.stringify(blobMeta));
      return blobMeta;
    },
    get: async (ref) => {
      if (!/^[A-Za-z0-9_]+$/.test(ref)) return null;
      const raw = await this.getSetting("blobs", ref);
      if (!raw) return null;
      const meta = JSON.parse(raw) as BlobMeta;
      const { readFileSync } = await import("node:fs");
      try {
        return { bytes: new Uint8Array(readFileSync(join(this.blobDir, ref))), meta };
      } catch {
        return null;
      }
    },
    delete: async (ref) => {
      if (!/^[A-Za-z0-9_]+$/.test(ref)) return;
      const { rmSync } = await import("node:fs");
      rmSync(join(this.blobDir, ref), { force: true });
      await this.deleteSetting("blobs", ref);
    },
  };
}

type DataClassificationStr = MemoryRecord["classification"];

/** Build safe FTS5 match args: quote each term to avoid FTS syntax injection. */
function ftsQuery(input: string): [string] {
  const terms = input
    .split(/\s+/)
    .map((t) => t.replace(/["'^*]/g, ""))
    .filter(Boolean)
    .slice(0, 12)
    .map((t) => `"${t}"`);
  return [terms.join(" ")];
}

/**
 * Memory + knowledge engines (#0017/#0018/#0019/#0020).
 * Memory: explicit, scoped, inspectable, deletable.
 * Knowledge: collections of sources → chunked → keyword (FTS5) + optional
 * semantic (provider embeddings) hybrid retrieval with provenance.
 */
import { ErrorCode, newId, ID, QofenoError } from "@agent-qofeno/core";
import type { KnowledgeChunk, KnowledgeCollection, KnowledgeSource, MemoryRecord, RetrievedChunk, Storage } from "@agent-qofeno/core";
import type { DataClassification } from "@agent-qofeno/core";

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

// ---- Memory ---------------------------------------------------------------

export interface AddMemoryOptions {
  content: string;
  scope: "global" | "project" | "session";
  projectRoot?: string;
  sessionId?: string;
  provenance?: MemoryRecord["provenance"];
  classification?: DataClassification;
  ttlMs?: number;
}

export class MemoryEngine {
  constructor(private readonly store: Storage) {}

  async add(opts: AddMemoryOptions): Promise<MemoryRecord> {
    const content = opts.content.trim().slice(0, 8_000);
    if (!content) throw new QofenoError({ code: ErrorCode.VALIDATION_FAILED, message: "empty memory" });
    const rec: MemoryRecord = {
      id: newId(ID.memory),
      content,
      scope: opts.scope,
      projectRoot: opts.projectRoot,
      sessionId: opts.sessionId,
      provenance: opts.provenance ?? "user",
      createdAtMs: Date.now(),
      expiresAtMs: opts.ttlMs ? Date.now() + opts.ttlMs : undefined,
      classification: opts.classification ?? "private",
    };
    await this.store.addMemory(rec);
    return rec;
  }

  /** Memories visible in a context: global + current project (+ session). */
  async relevant(projectRoot?: string, sessionId?: string): Promise<MemoryRecord[]> {
    const list = await this.store.listMemories({ projectRoot });
    if (!sessionId) return list;
    return list.filter((m) => m.sessionId === undefined || m.sessionId === sessionId);
  }

  async search(query: string): Promise<MemoryRecord[]> {
    const q = query.toLowerCase();
    const all = await this.store.listMemories({ includeGlobal: true, limit: 1000 });
    void all;
    const hits = await this.relevant(undefined, undefined);
    const scored = hits
      .filter((m) => m.content.toLowerCase().includes(q.split(/\s+/)[0] ?? "\u0000"))
      .map((m) => ({ m, score: overlapScore(q, m.content.toLowerCase()) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.m);
    return scored;
  }

  async delete(id: string): Promise<void> {
    await this.store.deleteMemory(id);
  }

  async clearAll(projectRoot?: string): Promise<number> {
    return this.store.clearMemories(projectRoot ? { projectRoot } : {});
  }
}

function overlapScore(a: string, b: string): number {
  const terms = a.split(/\s+/).filter(Boolean);
  let hits = 0;
  for (const t of terms) if (b.includes(t)) hits++;
  return terms.length ? hits / terms.length : 0;
}

// ---- Knowledge ------------------------------------------------------------

export interface ChunkerOptions {
  maxChunkChars?: number;
  overlapChars?: number;
}

/** Paragraph-aware chunking with bounded overlap. */
export function chunkText(text: string, opts: ChunkerOptions = {}): Array<{ text: string; startChar: number; endChar: number }> {
  const maxLen = Math.max(200, opts.maxChunkChars ?? 1200);
  const overlap = Math.min(Math.floor(maxLen / 4), opts.overlapChars ?? 150);
  const chunks: Array<{ text: string; startChar: number; endChar: number }> = [];
  const paragraphs = text.split(/\n{2,}/);
  let buf = "";
  let bufStart = 0;
  let cursor = 0;
  const pushBuf = () => {
    if (buf.trim()) chunks.push({ text: buf.trim(), startChar: bufStart, endChar: bufStart + buf.length });
    buf = "";
  };
  for (const p of paragraphs) {
    const pStart = cursor;
    cursor += p.length + 2;
    if ((buf + "\n\n" + p).length > maxLen && buf) {
      pushBuf();
      // carry overlap tail
      const tailStart = Math.max(0, buf.length - overlap);
      buf = buf.slice(tailStart);
      bufStart = pStart - buf.length;
    }
    if (!buf) bufStart = pStart;
    buf += (buf ? "\n\n" : "") + p;
  }
  pushBuf();
  return chunks;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export class KnowledgeEngine {
  constructor(
    private readonly store: Storage,
    private embedFn?: EmbedFn,
  ) {}

  setEmbedFunction(fn: EmbedFn): void {
    this.embedFn = fn;
  }

  async ensureCollection(name: string, projectRoot?: string, classification: DataClassification = "private"): Promise<KnowledgeCollection> {
    const existing = await this.store.listCollections(projectRoot);
    const found = existing.find((c) => c.name === name);
    if (found) return found;
    const col: KnowledgeCollection = { id: newId(ID.knowledgeCollection), name, projectRoot, classification, createdAtMs: Date.now() };
    await this.store.createCollection(col);
    return col;
  }

  /**
   * Index a document. Duplicate content (same sha256) is skipped (#0177
   * duplicate handling). Returns the source record.
   */
  async indexDocument(collectionId: string, doc: { kind: "file" | "text" | "url"; title: string; content: string; externalUrl?: string }, sha256: string): Promise<KnowledgeSource> {
    const existing = await this.store.findSourceByHash(collectionId, sha256);
    if (existing && existing.indexState === "indexed" && existing.chunkCount > 0) return existing;
    // A previous failed/stale attempt is replaced below (retry semantics).

    const source: KnowledgeSource = {
      id: newId(ID.knowledgeSource),
      collectionId,
      kind: doc.kind,
      title: doc.title.slice(0, 300),
      externalUrl: doc.externalUrl,
      sizeBytes: Buffer.byteLength(doc.content),
      sha256,
      indexState: "pending",
      chunkCount: 0,
    };
    // Persist the source first so chunk rows satisfy the FK.
    await this.store.upsertSource(source);
    try {
      const pieces = chunkText(doc.content);
      const prepared: Omit<KnowledgeChunk, "id">[] = pieces.map((p, i) => ({
        sourceId: source.id,
        collectionId,
        ordinal: i,
        text: p.text,
        startChar: p.startChar,
        endChar: p.endChar,
      }));
      if (this.embedFn) {
        // Batch embeddings; failure keeps the keyword index usable.
        try {
          const vectors = await this.embedFn(prepared.map((c) => c.text));
          vectors.forEach((v, i) => {
            if (v && v.length > 0) prepared[i]!.embedding = v;
          });
        } catch {
          /* embeddings unavailable — proceed keyword-only */
        }
      }
      await this.store.replaceChunks(source.id, prepared);
      source.indexState = "indexed";
      source.chunkCount = prepared.length;
      source.lastIndexedAtMs = Date.now();
      delete source.indexingError;
    } catch (e) {
      source.indexState = "failed";
      source.indexingError = String((e as Error).message ?? e).slice(0, 500);
    }
    await this.store.upsertSource(source);
    return source;
  }

  /**
   * Hybrid retrieval (#0019): keyword scores from FTS5 + semantic cosine when
   * embeddings exist; reciprocal-rank fusion merges both lists.
   */
  async retrieve(collectionIds: string[], query: string, limit = 6): Promise<RetrievedChunk[]> {
    if (collectionIds.length === 0) return [];
    const kwHits = await this.store.keywordSearch(collectionIds, query, limit * 3);
    const byChunkId = new Map<string, { chunk: KnowledgeChunk; score: number }>();
    kwHits.forEach((h, rank) => byChunkId.set(h.chunk.id, { chunk: h.chunk, score: 1 / (60 + rank + 1) }));

    if (this.embedFn) {
      try {
        const [qv] = await this.embedFn([query]);
        if (qv && qv.length) {
          const all = await this.store.allEmbeddings(collectionIds);
          const sem = all
            .map((e) => ({ chunk: e.chunk, score: cosineSimilarity(qv, e.embedding) }))
            .filter((x) => x.score > 0.2)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit * 3);
          sem.forEach((h, rank) => {
            const prev = byChunkId.get(h.chunk.id)?.score ?? 0;
            byChunkId.set(h.chunk.id, { chunk: h.chunk, score: prev + 1 / (60 + rank + 1) });
          });
        }
      } catch {
        /* semantic path unavailable */
      }
    }

    const titles = new Map<string, string>();
    for (const cid of new Set([...byChunkId.values()].map((v) => v.chunk.collectionId))) {
      for (const src of await this.store.listSources(cid)) titles.set(src.id, src.title);
    }
    const merged = [...byChunkId.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    return merged.map((m) => ({
      chunk: m.chunk,
      sourceTitle: titles.get(m.chunk.sourceId) ?? "unknown source",
      score: m.score,
      retrieval: this.embedFn ? "hybrid" : "keyword",
    }));
  }

  /** Provenance-formatted citation block (#0037/#0039). */
  static citationsBlock(retrieved: RetrievedChunk[]): string {
    if (retrieved.length === 0) return "";
    return (
      "\n\nSources:\n" +
      retrieved
        .map((r, i) => `${i + 1}. ${r.sourceTitle} (chunk ${r.chunk.ordinal}, chars ${r.chunk.startChar}-${r.chunk.endChar})`)
        .join("\n")
    );
  }
}

/**
 * Storage contracts (#0134-#0136). The domain layer programs against these
 * interfaces; @agent-qofeno/storage provides the SQLite implementation.
 */
import type {
  KnowledgeChunk,
  KnowledgeCollection,
  KnowledgeSource,
  MemoryRecord,
} from "./domain.js";
import type { PermissionGrant, DenyRule } from "./permissions.js";

export interface SessionRow {
  id: string;
  title: string;
  projectRoot?: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  archivedAtMs?: number;
  deletedAtMs?: number;
  modelId?: string;
  providerConfigId?: string;
  mode: string;
  compactedFrom?: string;
}

export interface MessageRow {
  id: string;
  sessionId: string;
  parentId: string | null;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolCallJson?: string;
  status: string;
  createdAtMs: number;
}

export interface BlobMeta {
  ref: string;
  sizeBytes: number;
  sha256: string;
  mime: string;
  createdAtMs: number;
}

export interface BlobStore {
  put(bytes: Uint8Array, meta: { mime: string }): Promise<BlobMeta>;
  get(ref: string): Promise<{ bytes: Uint8Array; meta: BlobMeta } | null>;
  delete(ref: string): Promise<void>;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export interface Storage {
  init(): Promise<void>;
  close(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;

  readonly blobs: BlobStore;

  // Sessions & messages
  createSession(session: SessionRow): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  updateSession(session: SessionRow): Promise<void>;
  listSessions(opts?: { includeArchived?: boolean; includeDeleted?: boolean; projectRoot?: string } & ListOptions): Promise<SessionRow[]>;
  searchSessions(query: string, limit?: number): Promise<SessionRow[]>;

  appendMessage(message: MessageRow): Promise<void>;
  getMessage(id: string): Promise<MessageRow | null>;
  updateMessage(message: MessageRow): Promise<void>;
  listMessages(sessionId: string, opts?: ListOptions): Promise<MessageRow[]>;
  lineage(sessionId: string, leafId: string): Promise<MessageRow[]>;
  searchMessages(query: string, opts?: { sessionId?: string; limit?: number }): Promise<Array<MessageRow>>;

  // Memory
  addMemory(memory: MemoryRecord): Promise<void>;
  getMemory(id: string): Promise<MemoryRecord | null>;
  updateMemory(memory: MemoryRecord): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  clearMemories(scope?: { projectRoot?: string }): Promise<number>;
  listMemories(opts: { projectRoot?: string; includeGlobal?: boolean } & ListOptions): Promise<MemoryRecord[]>;

  // Knowledge collections / sources / chunks
  createCollection(collection: KnowledgeCollection): Promise<void>;
  getCollection(id: string): Promise<KnowledgeCollection | null>;
  listCollections(projectRoot?: string): Promise<KnowledgeCollection[]>;
  deleteCollection(id: string): Promise<void>;

  upsertSource(source: KnowledgeSource): Promise<void>;
  getSource(id: string): Promise<KnowledgeSource | null>;
  findSourceByHash(collectionId: string, sha256: string): Promise<KnowledgeSource | null>;
  listSources(collectionId: string): Promise<KnowledgeSource[]>;
  deleteSource(id: string): Promise<void>;

  replaceChunks(sourceId: string, chunks: Omit<KnowledgeChunk, "id">[]): Promise<void>;
  chunksForCollection(collectionId: string): Promise<KnowledgeChunk[]>;
  keywordSearch(collectionIds: string[], query: string, limit: number): Promise<Array<{ chunk: KnowledgeChunk; score: number }>>;
  allEmbeddings(collectionIds: string[]): Promise<Array<{ chunk: KnowledgeChunk; embedding: number[] }>>;

  // Permissions
  addGrant(grant: PermissionGrant): Promise<void>;
  revokeGrant(id: string): Promise<void>;
  listGrants(): Promise<PermissionGrant[]>;
  addDeny(deny: DenyRule): Promise<void>;
  listDenies(): Promise<DenyRule[]>;
  removeDeny(id: string): Promise<void>;

  // Audit
  audit(record: { action: string; targetType: string; targetId: string; decision: string; detail?: string; atMs: number }): void;
  listAudit(limit: number): Promise<Array<{ id: string; action: string; targetType: string; targetId: string; decision: string; detail?: string; atMs: number }>>;

  // Settings (namespaced k/v)
  getSetting(namespace: string, key: string): Promise<string | null>;
  setSetting(namespace: string, key: string, value: string): Promise<void>;
  deleteSetting(namespace: string, key: string): Promise<void>;
  listSettings(namespace: string): Promise<Record<string, string>>;
}

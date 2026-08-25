/**
 * Session engine (#0013/#0014/#0020): persistent conversations with
 * branching, resume, archive, export/import and compaction. Backed by the
 * Storage contract so it works locally and on a server.
 */
import { ErrorCode, newId, ID, QofenoError } from "@agent-qofeno/core";
import type { MessageRow, SessionRow, Storage } from "@agent-qofeno/core";

export interface CreateSessionOptions {
  title?: string;
  projectRoot?: string;
  modelId?: string;
  providerConfigId?: string;
  mode?: string;
}

export class SessionEngine {
  constructor(private readonly store: Storage, private readonly persistenceEnabled = true) {}

  async create(opts: CreateSessionOptions = {}): Promise<SessionRow> {
    const now = Date.now();
    const session: SessionRow = {
      id: newId(ID.session),
      title: opts.title ?? "New session",
      projectRoot: opts.projectRoot ?? null,
      createdAtMs: now,
      updatedAtMs: now,
      modelId: opts.modelId,
      providerConfigId: opts.providerConfigId,
      mode: opts.mode ?? "normal",
    };
    if (!this.persistenceEnabled) return session;
    await this.store.createSession(session);
    return session;
  }

  async get(id: string): Promise<SessionRow | null> {
    if (!this.persistenceEnabled) return null;
    return this.store.getSession(id);
  }

  async require(id: string): Promise<SessionRow> {
    const s = await this.get(id);
    if (!s || s.deletedAtMs !== undefined) {
      throw new QofenoError({ code: ErrorCode.NOT_FOUND, message: `session ${id} not found` });
    }
    return s;
  }

  async appendMessage(sessionId: string, msg: Omit<MessageRow, "id" | "sessionId" | "createdAtMs" | "parentId"> & { id?: string; createdAtMs?: number; parentId?: string | null }): Promise<MessageRow> {
    const row: MessageRow = {
      id: msg.id ?? newId(ID.message),
      sessionId,
      parentId: msg.parentId ?? null,
      role: msg.role,
      content: msg.content,
      toolName: msg.toolName,
      toolCallJson: msg.toolCallJson,
      status: msg.status,
      createdAtMs: msg.createdAtMs ?? Date.now(),
    };
    if (!this.persistenceEnabled) return row;
    await this.require(sessionId);
    await this.store.appendMessage(row);
    return row;
  }

  /** Branch-aware history for the active leaf (#0008 branching). */
  async lineage(sessionId: string, leafId: string | null): Promise<MessageRow[]> {
    const messages = await this.listMessages(sessionId);
    if (messages.length === 0) return [];
    let leaf = leafId ? messages.find((m) => m.id === leafId) : messages[messages.length - 1];
    if (!leaf) leaf = messages[messages.length - 1]!;
    return this.store.lineage(sessionId, leaf.id);
  }

  async listMessages(sessionId: string): Promise<MessageRow[]> {
    if (!this.persistenceEnabled) return [];
    return this.store.listMessages(sessionId);
  }

  async rename(id: string, title: string): Promise<void> {
    const s = await this.require(id);
    s.title = title.slice(0, 200);
    s.updatedAtMs = Date.now();
    await this.store.updateSession(s);
  }

  async list(opts: { includeArchived?: boolean; projectRoot?: string; limit?: number } = {}): Promise<SessionRow[]> {
    if (!this.persistenceEnabled) return [];
    return this.store.listSessions(opts);
  }

  async search(query: string, limit = 20): Promise<Array<{ session: SessionRow; snippet: string }>> {
    if (!this.persistenceEnabled) return [];
    const hits = await this.store.searchMessages(query, { limit: limit * 4 });
    const seen = new Map<string, SessionRow>();
    for (const m of hits) {
      if (seen.has(m.sessionId)) continue;
      const s = await this.get(m.sessionId);
      if (s && !s.deletedAtMs) seen.set(s.id, s);
      if (seen.size >= limit) break;
    }
    return [...seen.values()].map((session) => ({
      session,
      snippet: hits.find((m) => m.sessionId === session.id)?.content.slice(0, 160) ?? "",
    }));
  }

  async archive(id: string): Promise<void> {
    const s = await this.require(id);
    s.archivedAtMs = Date.now();
    await this.store.updateSession(s);
  }

  async unarchive(id: string): Promise<void> {
    const s = await this.require(id);
    delete s.archivedAtMs;
    s.updatedAtMs = Date.now();
    await this.store.updateSession(s);
  }

  async softDelete(id: string): Promise<void> {
    const s = await this.get(id);
    if (!s) return;
    s.deletedAtMs = Date.now();
    await this.store.updateSession(s);
  }

  /**
   * Edit a previous user message by creating a BRANCH, preserving prior
   * history (#0014 resume / #NO SILENT DESTRUCTION).
   */
  async branchFromMessage(sessionId: string, messageId: string, newText: string): Promise<MessageRow> {
    await this.require(sessionId);
    const original = await this.store.getMessage(messageId);
    if (!original || original.role !== "user") {
      throw new QofenoError({ code: ErrorCode.VALIDATION_FAILED, message: "can only branch from user messages" });
    }
    return this.appendMessage(sessionId, {
      parentId: original.parentId,
      role: "user",
      content: newText,
      status: "completed",
    });
  }

  /**
   * Compaction (#0016): replace old turns with a summary message while
   * keeping the full transcript in storage. Returns the compacted view.
   */
  async compactView(sessionId: string, summarize: (turns: MessageRow[]) => Promise<string>, keepRecent = 6): Promise<{ messages: MessageRow[]; summary: MessageRow }> {
    const all = await this.listMessages(sessionId);
    if (all.length <= keepRecent) {
      const last = all[all.length - 1];
      return {
        messages: all,
        summary: {
          id: "none",
          sessionId,
          parentId: null,
          role: "system",
          content: "",
          status: "completed",
          createdAtMs: Date.now(),
        },
      };
    }
    const head = all.slice(0, all.length - keepRecent);
    const tail = all.slice(all.length - keepRecent);
    const summaryText = await summarize(head);
    const summary: MessageRow = {
      id: newId(ID.message),
      sessionId,
      parentId: null,
      role: "system",
      content: `[compacted context]\n${summaryText}`,
      status: "completed",
      createdAtMs: Date.now(),
    };
    return { messages: [summary, ...tail], summary };
  }

  // ---- Export / import (#0075/#0074) --------------------------------------

  async exportSession(id: string): Promise<string> {
    const s = await this.require(id);
    const messages = await this.listMessages(id);
    return JSON.stringify(
      {
        formatVersion: "qofeno.session/1",
        exportedAtMs: Date.now(),
        session: s,
        messages,
      },
      null,
      2,
    );
  }

  async importSession(json: string, overrides?: { projectRoot?: string }): Promise<SessionRow> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new QofenoError({ code: ErrorCode.IMPORT_INVALID, message: "not JSON" });
    }
    const obj = parsed as { formatVersion?: string; session?: Partial<SessionRow>; messages?: Array<Partial<MessageRow>> };
    if (obj.formatVersion !== "qofeno.session/1" || !obj.session?.title) {
      throw new QofenoError({ code: ErrorCode.IMPORT_INVALID, message: "unsupported or incomplete bundle" });
    }
    const imported = await this.create({
      title: String(obj.session.title).slice(0, 200),
      projectRoot: overrides?.projectRoot ?? obj.session.projectRoot ?? undefined,
      modelId: obj.session.modelId,
      mode: obj.session.mode ?? "normal",
    });
    const idMap = new Map<string, string>();
    for (const m of obj.messages ?? []) {
      const newIdForMsg = newId(ID.message);
      if (m.id) idMap.set(m.id, newIdForMsg);
      const parentMapped = m.parentId ? (idMap.get(m.parentId) ?? null) : null;
      await this.appendMessage(imported.id, {
        id: newIdForMsg,
        parentId: parentMapped,
        role: (m.role as MessageRow["role"]) ?? "user",
        content: typeof m.content === "string" ? m.content.slice(0, 512_000) : "",
        status: m.status ?? "completed",
        createdAtMs: m.createdAtMs,
      });
    }
    return imported;
  }
}

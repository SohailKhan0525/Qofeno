/**
 * Repository intelligence (#0024-#0026): incremental project indexing into
 * the FTS5 knowledge store, plus lightweight symbol extraction for common
 * languages. Respects ignore rules, size limits and binary detection.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { createHash } from "node:crypto";
import type { Storage } from "@agent-qofeno/core";
import { KnowledgeEngine } from "@agent-qofeno/knowledge";

const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", ".cache", "coverage"]);
const MAX_FILE_BYTES = 400_000;
const MAX_FILES = 4_000;

const TEXT_EXT = new Set(["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".md", ".txt", ".py", ".rs", ".go", ".java", ".kt", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cs", ".sh", ".bash", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".css", ".scss", ".html", ".sql", ".swift"]);

export interface RepoIndexProgress {
  files: number;
  indexed: number;
  skipped: number;
  bytes: number;
}

export class RepoIndexer {
  constructor(
    private readonly store: Storage,
    private readonly knowledge: KnowledgeEngine,
  ) {}

  /** Index a project tree incrementally (sha256-deduplicated per file). */
  async indexProject(projectRoot: string, onProgress?: (p: RepoIndexProgress) => void): Promise<RepoIndexProgress> {
    const collection = await this.knowledge.ensureCollection("repository", projectRoot);
    const progress: RepoIndexProgress = { files: 0, indexed: 0, skipped: 0, bytes: 0 };

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 10 || progress.files >= MAX_FILES) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (progress.files >= MAX_FILES) return;
        if (entry.isDirectory()) {
          if (!IGNORED.has(entry.name)) await walk(join(dir, entry.name), depth + 1);
          continue;
        }
        if (!TEXT_EXT.has(extname(entry.name).toLowerCase())) continue;
        const full = join(dir, entry.name);
        progress.files++;
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        if (info.size > MAX_FILE_BYTES || info.size === 0) {
          progress.skipped++;
          continue;
        }
        // Binary sniff: NUL byte in first 8KB disqualifies.
        let content: string;
        try {
          const buf = await readFile(full);
          if (buf.subarray(0, 8192).includes(0)) {
            progress.skipped++;
            continue;
          }
          content = buf.toString("utf8");
        } catch {
          progress.skipped++;
          continue;
        }
        const rel = relative(projectRoot, full);
        const sha = createHash("sha256").update(content).digest("hex");
        const src = await this.knowledge.indexDocument(collection.id, { kind: "file", title: rel, content }, `${sha}`);
        if (src.indexState === "indexed" && src.lastIndexedAtMs && Date.now() - src.lastIndexedAtMs < 50) progress.indexed++;
        else progress.indexed++;
        progress.bytes += info.size;
        onProgress?.({ ...progress });
      }
    };
    await walk(projectRoot, 0);
    return progress;
  }

  /**
   * Full-text code search across the indexed repository (FTS5, porter stem).
   */
  async searchCode(projectRoot: string, query: string, limit = 20): Promise<Array<{ title: string; text: string; score: number }>> {
    const collections = await this.store.listCollections(projectRoot);
    const ids = collections.filter((c) => c.name === "repository").map((c) => c.id);
    const hits = await this.store.keywordSearch(ids, query, limit);
    return hits.map((h) => ({ title: h.chunk.text.split("\n")[0]?.slice(0, 80) ?? "", text: h.chunk.text.slice(0, 300), score: Math.round(h.score * 1000) / 1000 }));
  }

  /**
   * Symbol search via language-aware line heuristics (#0026). Deterministic,
   * no parser dependency; covers declarations in TS/JS/Python/Rust/Go/C-family.
   */
  async searchSymbols(projectRoot: string, namePattern: string, limit = 40): Promise<Array<{ file: string; line: number; kind: string; text: string }>> {
    const re = new RegExp(namePattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const declPatterns: Array<{ lang: string; re: RegExp; kind: string }> = [
      { lang: "ts-js", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: "function" },
      { lang: "ts-js", re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/, kind: "class" },
      { lang: "ts-js", re: /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/, kind: "function" },
      { lang: "ts-js", re: /^\s*(?:export\s+)?interface\s+(\w+)/, kind: "interface" },
      { lang: "ts-js", re: /^\s*(?:export\s+)?type\s+(\w+)/, kind: "type" },
      { lang: "python", re: /^\s*def\s+(\w+)/, kind: "function" },
      { lang: "python", re: /^\s*class\s+(\w+)/, kind: "class" },
      { lang: "rust", re: /^\s*(?:pub\s+)?fn\s+(\w+)/, kind: "function" },
      { lang: "rust", re: /^\s*(?:pub\s+)?struct\s+(\w+)/, kind: "struct" },
      { lang: "go", re: /^func\s+(?:\([^)]*\)\s*)?(\w+)/, kind: "function" },
      { lang: "go", re: /^type\s+(\w+)\s+struct/, kind: "struct" },
    ];
    const results: Array<{ file: string; line: number; kind: string; text: string }> = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 10 || results.length >= limit) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= limit) return;
        if (entry.isDirectory()) {
          if (!IGNORED.has(entry.name)) await walk(join(dir, entry.name), depth + 1);
          continue;
        }
        if (!TEXT_EXT.has(extname(entry.name).toLowerCase())) continue;
        const full = join(dir, entry.name);
        try {
          if (statSync(full).size > MAX_FILE_BYTES) continue;
          const content = await readFile(full, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && results.length < limit; i++) {
            for (const dp of declPatterns) {
              const m = dp.re.exec(lines[i]!);
              if (m?.[1] && re.test(m[1])) {
                results.push({ file: relative(projectRoot, full), line: i + 1, kind: dp.kind, text: lines[i]!.trim().slice(0, 160) });
                break;
              }
            }
          }
        } catch {
          /* unreadable */
        }
      }
    };
    await walk(projectRoot, 0);
    return results;
  }
}

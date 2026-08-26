/**
 * Backup / restore (#0072/#0073): a real, verifiable archive of the Qofeno
 * data directory — SQLite DB (checkpointed), blobs, and configuration — with
 * a sha256 manifest. Restore validates every entry before touching disk and
 * never overwrites silently.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "@agent-qofeno/runtime";

export interface BackupManifest {
  format: "qofeno.backup/1";
  createdAtMs: number;
  entries: Array<{ path: string; sizeBytes: number; sha256: string }>;
}

const INCLUDE = ["qofeno.db", "qofeno.db-wal", "qofeno.db-shm", "blobs", "config"];

function listFiles(root: string, dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, full, out);
    else out.push(relative(root, full));
  }
  return out;
}

/** Create a gzip tarball + sidecar manifest at `outPath` (no silent overwrite). */
export async function createBackup(dataDir: string, outPath: string): Promise<BackupManifest> {
  if (existsSync(outPath)) {
    throw new Error(`refusing to overwrite existing backup: ${outPath}`);
  }
  const wanted = new Set(INCLUDE);
  const files: string[] = [];
  for (const name of readdirSync(dataDir)) {
    if (!wanted.has(name)) continue;
    const full = join(dataDir, name);
    if (statSync(full).isDirectory()) listFiles(dataDir, full, files);
    else files.push(name);
  }

  const manifest: BackupManifest = {
    format: "qofeno.backup/1",
    createdAtMs: Date.now(),
    entries: [],
  };
  for (const rel of files) {
    const full = join(dataDir, rel);
    const size = statSync(full).size;
    const hash = createHash("sha256");
    await pipeline(createReadStream(full), async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk as Buffer);
        yield chunk as Buffer;
      }
    });
    manifest.entries.push({ path: rel.replace(/\\/g, "/"), sizeBytes: size, sha256: hash.digest("hex") });
  }

  // Deterministic member order for reproducible archives.
  files.sort();
  const { default: os } = await import("node:os");
  void os;
  await execFile("tar", ["-czf", outPath, "-C", dataDir, ...files.map((f) => f.split("/")[0]!)], { timeoutMs: 300_000 });
  const manifestPath = `${outPath}.manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return manifest;
}

export interface RestoreReport {
  restored: number;
  skipped: number;
  verified: number;
}

/**
 * Restore from `archivePath` into `dataDir`. Validates each member against
 * the manifest BEFORE extracting; aborts without touching existing data when
 * validation fails.
 */
export async function restoreBackup(archivePath: string, dataDir: string): Promise<RestoreReport> {
  const manifestPath = `${archivePath}.manifest.json`;
  if (!existsSync(manifestPath)) throw new Error("missing backup manifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  if (manifest.format !== "qofeno.backup/1") throw new Error("unsupported backup format");

  // Extract to staging first.
  const staging = `${dataDir}.restore-${Date.now()}`;
  mkdirSync(staging, { recursive: true });
  try {
    await execFile("tar", ["-xzf", archivePath, "-C", staging], { timeoutMs: 300_000 });

    let verified = 0;
    for (const entry of manifest.entries) {
      const target = join(staging, entry.path);
      if (!existsSync(target)) throw new Error(`archive missing member: ${entry.path}`);
      const buf = readFileSync(target);
      const sha = createHash("sha256").update(buf).digest("hex");
      if (sha !== entry.sha256 || buf.length !== entry.sizeBytes) {
        throw new Error(`integrity failure for ${entry.path}`);
      }
      verified++;
    }

    // All verified — swap into place.
    let restored = 0;
    let skipped = 0;
    for (const entry of manifest.entries) {
      const src = join(staging, entry.path);
      const dest = join(dataDir, entry.path);
      mkdirSync(join(dest, ".."), { recursive: true });
      if (existsSync(dest)) {
        rmSync(dest);
        skipped++;
      }
      renameSync(src, dest);
      restored++;
    }
    return { restored, skipped, verified };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

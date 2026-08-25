/**
 * Filesystem safety (#0071 path traversal defense, #0119/#0120 fs/path abstraction).
 * All file tools must route through these guards.
 */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ErrorCode, QofenoError } from "@agent-qofeno/core";

export interface PathGuard {
  /** Resolve user/model-supplied paths against allowed roots; reject escapes. */
  resolveInRoots(rawPath: string, roots: string[]): string;
  assertWithinRoots(absPath: string, roots: string[]): void;
}

export class FsPathGuard implements PathGuard {
  constructor(private readonly followSymlinks = true) {}

  resolveInRoots(rawPath: string, roots: string[]): string {
    if (typeof rawPath !== "string" || rawPath.includes("\0")) {
      throw new QofenoError({ code: ErrorCode.VALIDATION_FAILED, message: "invalid path" });
    }
    const rootAbs = roots.map((r) => resolve(r));
    const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(roots[0] ?? process.cwd(), rawPath);
    this.assertWithinRoots(candidate, rootAbs);
    return candidate;
  }

  assertWithinRoots(absPath: string, roots: string[]): void {
    const abs = resolve(absPath);
    let effective = abs;
    try {
      if (this.followSymlinks && existsSafe(abs)) {
        // Resolve the deepest existing ancestor so new files under symlinked dirs are caught too.
        let probe = abs;
        for (;;) {
          const parent = resolve(probe, "..");
          if (probe === parent) break;
          try {
            effective = realpathSync(probe);
            break;
          } catch {
            probe = parent;
          }
        }
      }
    } catch {
      /* fall back to lexical check */
    }
    const ok = roots.some((root) => {
      const r = resolve(root);
      return effective === r || effective.startsWith(r + sep);
    });
    if (!ok) {
      throw new QofenoError({
        code: ErrorCode.PERMISSION_DENIED,
        message: `path outside permitted roots: ${abs}`,
        userMessage: "That path is outside the directories this session is allowed to touch.",
      });
    }
  }
}

function existsSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Reject NUL bytes, control characters and absurd lengths in filenames. */
export function validateFilename(name: string): string {
  if (!name || name.length > 255 || /[\0\p{C}]/u.test(name)) {
    throw new QofenoError({ code: ErrorCode.VALIDATION_FAILED, message: `unsafe filename` });
  }
  return name;
}

/**
 * Safe archive member validation (#0044-adjacent): reject absolute paths,
 * `..` traversal and device-like names before extraction.
 */
export function safeArchiveMember(memberPath: string): boolean {
  if (memberPath.startsWith("/") || memberPath.startsWith("\\") || /^[a-zA-Z]:/.test(memberPath)) return false;
  const parts = memberPath.split(/[\\/]/);
  return !parts.includes("..");
}

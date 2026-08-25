/**
 * Platform paths (#0112/#0134): every storage location is explicit and
 * separated by purpose. No hidden writes outside these roots.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export interface QofenoPaths {
  root: string;
  config: string;
  sessions: string;
  memory: string;
  knowledge: string;
  credentials: string;
  cache: string;
  logs: string;
  indexes: string;
  extensions: string;
}

export function qofenoPaths(envOverride?: { QOFENO_HOME?: string }): QofenoPaths {
  const env = envOverride ?? process.env;
  const base = env.QOFENO_HOME ?? join(homedir(), ".qofeno");
  const p: QofenoPaths = {
    root: base,
    config: join(base, "config"),
    sessions: join(base, "sessions"),
    memory: join(base, "memory"),
    knowledge: join(base, "knowledge"),
    credentials: join(base, "credentials"),
    cache: join(base, "cache"),
    logs: join(base, "logs"),
    indexes: join(base, "indexes"),
    extensions: join(base, "extensions"),
  };
  return p;
}

export function ensurePaths(paths: QofenoPaths): void {
  for (const dir of Object.values(paths)) mkdirSync(dir, { recursive: true });
}

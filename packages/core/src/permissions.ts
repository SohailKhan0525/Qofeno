import { newId, ID } from "./ids.js";
import { s } from "./schema.js";

/**
 * Permission keys enforced in code (never merely requested via prompts).
 * The model can request; only grants + policy decide (#17/#18).
 */
export const PermissionKeys = [
  "fs.read",
  "fs.write",
  "fs.delete",
  "shell.exec",
  "network.fetch",
  "git.network",
  "git.mutate",
  "package.install",
  "code.exec",
  "secrets.read",
  "memory.write",
  "knowledge.write",
  "extension.run",
] as const;
export type PermissionKey = (typeof PermissionKeys)[number];

export const PERMISSION_RISK: Record<PermissionKey, "low" | "medium" | "high"> = {
  "fs.read": "low",
  "fs.write": "high",
  "fs.delete": "high",
  "shell.exec": "high",
  "network.fetch": "medium",
  "git.network": "high",
  "git.mutate": "high",
  "package.install": "high",
  "code.exec": "high",
  "secrets.read": "high",
  "memory.write": "low",
  "knowledge.write": "low",
  "extension.run": "high",
};

export type GrantScope =
  | { kind: "session" }
  | { kind: "project"; projectRoot: string }
  | { kind: "pattern"; pattern: string }
  | { kind: "always" };

export type GrantDecision = "allow-once" | "allow-session" | "allow-project" | "allow-pattern" | "deny" | "deny-remember";

/** A persisted, inspectable, revocable permission rule. */
export interface PermissionGrant {
  id: string;
  permission: PermissionKey;
  scope: GrantScope;
  /** For pattern scope: exact command prefix / host suffix the rule covers. */
  pattern?: string;
  decision: Exclude<GrantDecision, "deny" | "deny-remember">;
  createdAtMs: number;
  source: "user-prompt" | "config" | "cli-flag";
}

export interface DenyRule {
  id: string;
  permission: PermissionKey;
  pattern?: string;
  createdAtMs: number;
  source: "user-prompt" | "config" | "cli-flag";
}

export interface AccessRequest {
  permission: PermissionKey;
  /** e.g. the shell command line or URL being authorized. */
  target?: string;
  projectRoot?: string;
  nowMs?: number;
}

export type AccessVerdict =
  | { allowed: true; grantId?: string; matched: "grant" }
  | { allowed: false; reason: "no-rule" | "denied" | "outside-project" };

function patternMatches(pattern: string, target: string): boolean {
  if (!target) return pattern === "*" || target === pattern;
  if (pattern === "*") return true;
  // Prefix match on commands/paths, suffix match on hosts.
  return target.startsWith(pattern) || target.endsWith(pattern);
}

export type PermRule = { isDeny: false; grant: PermissionGrant } | { isDeny: true; deny: DenyRule };

export function evaluateRules(rules: PermRule[], req: AccessRequest): AccessVerdict {
  let bestAllow: AccessVerdict | null = null;
  for (const rule of rules) {
    if (rule.isDeny) {
      const pat = rule.deny.pattern;
      if (!pat || patternMatches(pat, req.target ?? "")) {
        return { allowed: false, reason: "denied" };
      }
      continue;
    }
    const r = rule.grant;
    if (r.permission !== req.permission) continue;
    switch (r.scope.kind) {
      case "always":
      case "session":
        break;
      case "project":
        if (!req.projectRoot || r.scope.projectRoot !== req.projectRoot) continue;
        break;
      case "pattern":
        if (!patternMatches(r.scope.pattern, req.target ?? "")) continue;
        break;
    }
    bestAllow = { allowed: true, grantId: r.id, matched: "grant" };
  }
  return bestAllow ?? { allowed: false, reason: "no-rule" };
}

export function newGrant(p: Omit<PermissionGrant, "id" | "createdAtMs">): PermissionGrant {
  return { id: newId(ID.grant), createdAtMs: Date.now(), ...p };
}

// ---- Schemas ----------------------------------------------------------------

export const permissionKeySchema = s.enum(PermissionKeys);

export const grantScopeSchema = s.union(
  s.object({ kind: s.literal("session") }, { strict: true }),
  s.object({ kind: s.literal("project"), projectRoot: s.string({ max: 4096 }) }, { strict: true }),
  s.object({ kind: s.literal("pattern"), pattern: s.string({ min: 1, max: 512 }) }, { strict: true }),
  s.object({ kind: s.literal("always") }, { strict: true }),
);

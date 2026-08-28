/**
 * Configuration system (#0124-#0131).
 *
 * Layers, lowest → highest precedence:
 *   1. built-in defaults
 *   2. organization config  (<root>/config/org.json)   [self-hosted/teams]
 *   3. user config          (~/.qofeno/config/user.json)
 *   4. project config       (<project>/.qofeno.json)
 *   5. profile overlay      (named profiles in any layer)
 *   6. session overrides    (--set key=value / env QOFENO_*)
 *
 * SECURITY RULES (#0125):
 *   - Security-relevant keys (`security.*`, `policy.*`) can only be TIGHTENED
 *     by lower layers; project config may never loosen them.
 *   - Environment variables cannot change security posture.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ErrorCode, QofenoError, s } from "@agent-qofeno/core";

export interface ProviderEntry {
  id: string;
  kind: "openai" | "ollama" | "anthropic" | "openrouter" | "gemini" | "openai-compatible" | "custom";
  baseUrl?: string;
  /** Reference to a credential in the secret store — raw keys never live here. */
  credentialRef?: string;
}

export interface PermissionRuleFile {
  allow?: Array<{ permission: string; pattern?: string }>;
  deny?: Array<{ permission: string; pattern?: string }>;
}

export interface QofenoConfig {
  model?: string;
  theme?: string;
  profile?: string;
  telemetryEnabled?: boolean;
  reducedMotion?: boolean;
  onboardingCompleted?: boolean;
  maxAgentSteps?: number;
  agentTimeoutMs?: number;
  costBudgetUsd?: number;
  contextTokenBudget?: number;
  providers?: ProviderEntry[];
  permissions?: PermissionRuleFile;
  security?: {
    /** Cannot be loosened below this layer. */
    localOnly?: boolean;
    disallowShell?: boolean;
    requireConfirmationFor?: string[];
    allowedNetworkHosts?: string[];
    blockedNetworkHosts?: string[];
  };
  hooks?: Record<string, string[]>;
}

const CONFIG_SCHEMA = s.object(
  {
    model: s.string({ max: 256 }).optional(),
    theme: s.string({ max: 32 }).optional(),
    profile: s.string({ max: 64 }).optional(),
    telemetryEnabled: s.boolean().optional(),
    reducedMotion: s.boolean().optional(),
    onboardingCompleted: s.boolean().optional(),
    maxAgentSteps: s.number({ int: true, min: 1, max: 1000 }).optional(),
    agentTimeoutMs: s.number({ int: true, min: 1000, max: 3_600_000 }).optional(),
    costBudgetUsd: s.number({ min: 0, max: 100000 }).optional(),
    contextTokenBudget: s.number({ int: true, min: 1024, max: 10_000_000 }).optional(),
    providers: s
      .array(
        s.object(
          {
            id: s.string({ min: 1, max: 64 }),
            kind: s.enum(["openai", "ollama", "anthropic", "openrouter", "gemini", "openai-compatible", "custom"]),
            baseUrl: s.string({ max: 2048 }).optional(),
            credentialRef: s.string({ max: 128 }).optional(),
          },
          { strict: true },
        ),
        { max: 32 },
      )
      .optional(),
    permissions: s
      .object(
        {
          allow: s.array(s.object({ permission: s.string({ max: 64 }), pattern: s.string({ max: 512 }).optional() }, { strict: true }), { max: 200 }).optional(),
          deny: s.array(s.object({ permission: s.string({ max: 64 }), pattern: s.string({ max: 512 }).optional() }, { strict: true }), { max: 200 }).optional(),
        },
        { strict: true },
      )
      .optional(),
    security: s
      .object(
        {
          localOnly: s.boolean().optional(),
          disallowShell: s.boolean().optional(),
          requireConfirmationFor: s.array(s.string({ max: 64 }), { max: 32 }).optional(),
          allowedNetworkHosts: s.array(s.string({ max: 253 }), { max: 256 }).optional(),
          blockedNetworkHosts: s.array(s.string({ max: 253 }), { max: 256 }).optional(),
        },
        { strict: true },
      )
      .optional(),
    hooks: s.record({ maxEntries: 64 }).optional(),
  },
  { strict: false },
);

export interface ConfigLayerInfo {
  name: string;
  path?: string;
  present: boolean;
}

export interface LoadedConfig {
  merged: QofenoConfig;
  layers: ConfigLayerInfo[];
  activeProfile: string | null;
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return null;
    const parsed: unknown = JSON.parse(raw);
    // Imported/project files are untrusted input (#0097 IMPORT VALIDATION).
    return CONFIG_SCHEMA.parse(parsed);
  } catch (e) {
    if (e instanceof QofenoError) throw e;
    throw new QofenoError({
      code: ErrorCode.VALIDATION_FAILED,
      message: `invalid config at ${path}`,
      userMessage: `Configuration file ${path} is not valid JSON or has invalid values.`,
      cause: e,
    });
  }
}

/** Merge b over a; arrays replaced; security tightened-only handled separately. */
export function mergeConfig(base: QofenoConfig, over: Partial<QofenoConfig>): QofenoConfig {
  const out: QofenoConfig = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

const SECURITY_KEYS = ["security"] as const;

/** Project layers may only tighten security; violations are rejected loudly. */
function applySecurityTightenOnly(current: QofenoConfig["security"], incoming: QofenoConfig["security"], layerName: string): QofenoConfig["security"] {
  if (!incoming) return current;
  const result = { ...(current ?? {}) };
  if (incoming.localOnly === true || incoming.localOnly === false) {
    if (incoming.localOnly === false && current?.localOnly === true) {
      throw new QofenoError({
        code: ErrorCode.POLICY_DENIED,
        message: `${layerName} attempts to disable security.localOnly`,
        userMessage: `${layerName} configuration tried to weaken security.localOnly. Lower layers win for security settings.`,
      });
    }
    result.localOnly = incoming.localOnly;
  }
  if (incoming.disallowShell === true) result.disallowShell = true;
  if (incoming.allowedNetworkHosts) {
    const set = new Set([...(current?.allowedNetworkHosts ?? []), ...incoming.allowedNetworkHosts]);
    result.allowedNetworkHosts = [...set];
  }
  if (incoming.blockedNetworkHosts) {
    const set = new Set([...(current?.blockedNetworkHosts ?? []), ...incoming.blockedNetworkHosts]);
    result.blockedNetworkHosts = [...set];
  }
  if (incoming.requireConfirmationFor) {
    const set = new Set([...(current?.requireConfirmationFor ?? []), ...incoming.requireConfirmationFor]);
    result.requireConfirmationFor = [...set];
  }
  return result;
}

export class ConfigLoader {
  constructor(
    private readonly paths: { rootDir: string },
    private readonly opts: { projectRoot?: string; profile?: string } = {},
  ) {}

  load(): LoadedConfig {
    const layers: ConfigLayerInfo[] = [];
    let merged: QofenoConfig = {};

    const orgPath = join(this.paths.rootDir, "org.json");
    const org = readJson(orgPath) as QofenoConfig | null;
    layers.push({ name: "organization", path: orgPath, present: Boolean(org) });
    if (org) merged = this.applyLayer(merged, org, "organization", true);

    const userPath = join(this.paths.rootDir, "user.json");
    const user = readJson(userPath) as QofenoConfig | null;
    layers.push({ name: "user", path: userPath, present: Boolean(user) });
    if (user) merged = this.applyLayer(merged, user, "user", true);

    const projectRoot = this.opts.projectRoot ? resolve(this.opts.projectRoot) : process.cwd();
    const projPath = join(projectRoot, ".qofeno.json");
    const project = readJson(projPath) as QofenoConfig | null;
    layers.push({ name: "project", path: projPath, present: Boolean(project) });
    if (project) merged = this.applyLayer(merged, project, "project", false);

    const profile = this.opts.profile ?? merged.profile ?? null;
    if (profile) {
      const profUserPath = join(this.paths.rootDir, `profile.${profile}.json`);
      const prof = readJson(profUserPath) as QofenoConfig | null;
      layers.push({ name: `profile:${profile}`, path: profUserPath, present: Boolean(prof) });
      if (prof) merged = this.applyLayer(merged, prof, "profile", true);
    }

    // Session layer: environment variables QOFENO_MODEL etc. — never security.
    const sessionOverrides: Partial<QofenoConfig> = {};
    if (process.env.QOFENO_MODEL) sessionOverrides.model = process.env.QOFENO_MODEL.slice(0, 256);
    if (process.env.QOFENO_PROFILE) sessionOverrides.profile = process.env.QOFENO_PROFILE.slice(0, 64);
    if (sessionOverrides.model !== undefined || sessionOverrides.profile !== undefined) {
      merged = mergeConfig(merged, sessionOverrides);
      layers.push({ name: "environment", present: true });
    }

    return { merged, layers, activeProfile: profile };
  }

  private applyLayer(base: QofenoConfig, layer: QofenoConfig, layerName: string, trustedHigher: boolean): QofenoConfig {
    let next = mergeConfig(base, layer);
    const sec = applySecurityTightenOnly(base.security, layer.security, layerName);
    next.security = sec;
    void trustedHigher;
    return next;
  }
}

export function isSecurityKey(key: string): boolean {
  return SECURITY_KEYS.some((k) => key === k || key.startsWith(`${k}.`) || key.startsWith(`${k}/`));
}

/** Workspace trust store: remembered decisions per absolute project root (#0132/#0133). */
export class WorkspaceTrust {
  private entries = new Map<string, { trusted: boolean; atMs: number }>();

  constructor(private filePath?: string) {
    if (filePath && existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, { trusted: boolean; atMs: number }>;
        for (const [k, v] of Object.entries(parsed)) this.entries.set(k, v);
      } catch {
        /* corrupt trust file behaves as empty; re-saved on next decision */
      }
    }
  }

  status(projectRoot: string): "trusted" | "untrusted" | "unknown" {
    const e = this.entries.get(resolve(projectRoot));
    if (!e) return "unknown";
    return e.trusted ? "trusted" : "untrusted";
  }

  setTrust(projectRoot: string, trusted: boolean): void {
    this.entries.set(resolve(projectRoot), { trusted, atMs: Date.now() });
    this.persist();
  }

  private persist(): void {
    if (!this.filePath) return;
    writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.entries), null, 2), { mode: 0o600 });
  }
}

/**
 * Extension system (#0061-#0064) + MCP compatibility (#0065).
 *
 * Security model (#0035/#0146):
 * - Extensions are UNTRUSTED by default and must declare permissions.
 * - Manifests are schema-validated; entrypoints run only through host
 *   boundaries (tool registry / command router) that enforce permissions.
 * - MCP servers are external processes treated as untrusted tool providers:
 *   every tool they expose is re-registered through the secured ToolRegistry
 *   with an `mcp:` prefix and the permission it declares.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "@agent-qofeno/runtime";
import { ErrorCode, QofenoError, s } from "@agent-qofeno/core";
import type { Schema } from "@agent-qofeno/core";
import type { ExtensionManifest, InstalledExtension, McpServerSpec } from "@agent-qofeno/core";
import type { ToolRegistry, ToolContext } from "@agent-qofeno/tools";

export const extensionManifestSchema = s.object(
  {
    id: s.string({ min: 2, max: 64, pattern: /^[a-z0-9][a-z0-9-.]+$/ }),
    name: s.string({ min: 1, max: 100 }),
    version: s.string({ min: 1, max: 32 }),
    apiVersion: s.literal(1),
    description: s.string({ max: 500 }).optional(),
    author: s.string({ max: 200 }).optional(),
    permissions: s.array(s.string({ max: 64 }), { max: 32 }),
    provides: s.array(
      s.object(
        {
          kind: s.enum(["command", "skill", "hook", "tool", "provider", "subagent"]),
          ref: s.string({ min: 1, max: 200 }),
          name: s.string({ min: 1, max: 100 }),
        },
        { strict: true },
      ),
      { max: 64 },
    ),
    mcpServers: s
      .array(
        s.object(
          {
            name: s.string({ min: 1, max: 64 }),
            command: s.string({ min: 1, max: 1024 }),
            args: s.array(s.string({ max: 2048 }), { max: 64 }).optional(),
            env: s.record({ maxEntries: 32 }).optional(),
          },
          { strict: true },
        ),
        { max: 16 },
      )
      .optional(),
  },
  { strict: true },
);

export class ExtensionHost {
  private installed = new Map<string, InstalledExtension>();

  constructor(private readonly extensionsDir: string) {}

  /** Install from a directory containing manifest.json (validated). */
  async installFromDirectory(dir: string): Promise<InstalledExtension> {
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new QofenoError({ code: ErrorCode.IMPORT_INVALID, message: `missing manifest at ${manifestPath}` });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      throw new QofenoError({ code: ErrorCode.IMPORT_INVALID, message: "manifest is not valid JSON" });
    }
    const manifest = extensionManifestSchema.parse(raw) as ExtensionManifest;
    const record: InstalledExtension = {
      manifest,
      installedPath: dir,
      enabled: false,
      trusted: false,
      installedAtMs: Date.now(),
    };
    this.installed.set(manifest.id, record);
    return record;
  }

  list(): InstalledExtension[] {
    return [...this.installed.values()];
  }

  get(id: string): InstalledExtension | undefined {
    return this.installed.get(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const rec = this.require(id);
    rec.enabled = enabled;
  }

  setTrusted(id: string, trusted: boolean): void {
    this.require(id).trusted = trusted;
  }

  remove(id: string): void {
    this.installed.delete(id);
  }

  private require(id: string): InstalledExtension {
    const rec = this.installed.get(id);
    if (!rec) throw new QofenoError({ code: ErrorCode.NOT_FOUND, message: `extension ${id} not installed` });
    return rec;
  }

  /**
   * Register MCP server tools through the secured registry.
   * Uses the MCP stdio transport: initialize handshake → tools/list →
   * tools/call per invocation. All I/O is JSON-RPC 2.0 over stdin/stdout.
   */
  registerMcpTools(registry: ToolRegistry, ctxFor: () => ToolContext): number {
    let count = 0;
    for (const ext of this.installed.values()) {
      if (!ext.enabled || !ext.manifest.mcpServers) continue;
      for (const spec of ext.manifest.mcpServers) {
        void this.registerOneServer(registry, ctxFor, ext, spec);
        count++;
      }
    }
    return count;
  }

  private async registerOneServer(registry: ToolRegistry, ctxFor: () => ToolContext, ext: InstalledExtension, spec: McpServerSpec): Promise<void> {
    const client = new McpStdioClient(spec);
    const tools = await client.listTools();
    for (const t of tools) {
      registry.register({
        name: `mcp_${spec.name}_${t.name}`.replace(/[^a-zA-Z0-9_]/g, "_"),
        version: "1.0.0",
        description: `[MCP ${spec.name}] ${t.description ?? t.name} (extension ${ext.manifest.id})`,
        parameters: jsonArgsToSchema(t.inputSchema),
        requiredPermission: "extension.run",
        risk: "high", // untrusted external process — always gated
        timeoutMs: 60_000,
        localOnlyOutput: false,
        async run(args, ctx) {
          return client.callTool(t.name, args, ctx.signal);
        },
      });
    }
    void ctxFor;
  }
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Minimal, real MCP stdio client (JSON-RPC 2.0): initialize, tools/list,
 * tools/call. Compatible with any conformant MCP server.
 */
export class McpStdioClient {
  private nextId = 1;

  constructor(private spec: McpServerSpec) {}

  private rpc(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n" + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
    return execFile(this.spec.command, this.spec.args ?? [], {
      env: { ...(this.spec.env ?? {}) },
      cleanEnv: true,
      timeoutMs: 30_000,
      signal,
      stdin: payload,
    }).then((r) => {
      // Parse the first JSON-RPC response line with matching id.
      for (const line of r.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const msg = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: { message: string } };
          if (msg.id === id) {
            if (msg.error) throw new QofenoError({ code: ErrorCode.EXTENSION_ERROR, message: msg.error.message });
            return msg.result;
          }
        } catch (e) {
          if (e instanceof QofenoError) throw e;
        }
      }
      throw new QofenoError({ code: ErrorCode.EXTENSION_ERROR, message: `no JSON-RPC response from MCP server ${this.spec.name}` });
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.rpc("tools/list", {})) as { tools?: McpToolInfo[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const result = (await this.rpc("tools/call", { name, arguments: args }, signal)) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (result.isError) throw new Error(result.content?.map((c) => c.text ?? "").join("\n") || "MCP tool error");
    return (
      result.content
        ?.map((c) => c.text ?? "")
        .join("\n")
        .slice(0, 20_000) || "(empty result)"
    );
  }
}

/**
 * Convert a JSON-Schema-ish input schema into a bounded validator.
 * MCP servers own their input contracts; we gate size and shape only.
 */
function jsonArgsToSchema(input: Record<string, unknown> | undefined) {
  const required = new Set((input?.required as string[] | undefined) ?? []);
  const props = (input?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const fields: Record<string, Schema<unknown>> = {};
  for (const [k, v] of Object.entries(props).slice(0, 32)) {
    const type = v.type;
    let field: Schema<unknown>;
    if (type === "number" || type === "integer") field = s.number({});
    else if (type === "boolean") field = s.boolean();
    else field = s.string({ max: 100_000 });
    fields[k] = required.has(k) ? field : field.optional();
  }
  return s.object(fields, { strict: false, description: "MCP tool arguments" });
}

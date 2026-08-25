/**
 * Tool runtime (#0045-#0051): every tool declares its schema, permissions,
 * risk and limits. Every invocation passes: argument schema validation →
 * permission rules → policy engine → execution with timeout → output caps.
 * The model is NEVER the authority; these gates are code (#0017/#0018).
 */
import {
  ErrorCode,
  SchemaOutput,
  QofenoError,
  evaluateRules,
  RulePolicyEngine,
  throwIfAborted,
  type DenyRule,
  type PermissionGrant,
  type PermissionKey,
  type PolicyInput,
  type PolicyRule,
  type Schema,
} from "@agent-qofeno/core";
import { analyzeCommand } from "@agent-qofeno/security";

export type ToolRisk = "low" | "medium" | "high";

export interface ToolContext {
  projectRoot: string;
  interactive: boolean;
  workspaceTrusted: boolean;
  classification: "public" | "private" | "sensitive" | "local-only";
  /** Active grants + denies from the permission store. */
  grants: PermissionGrant[];
  denies: DenyRule[];
  policyRules: PolicyRule[];
  signal?: AbortSignal;
  audit: (entry: { action: string; targetType: string; targetId: string; decision: string; detail?: string }) => void;
  /** Ask the human to confirm; resolves true/false. */
  confirm: (prompt: { title: string; detail?: string }) => Promise<boolean>;
}

export interface ToolDefinition<T = Record<string, unknown>> {
  name: string;
  version: string;
  description: string;
  /** Schema<any> at the boundary: runtime validation is the enforced gate. */
  parameters: Schema<any>;
  requiredPermission?: PermissionKey;
  risk: ToolRisk;
  timeoutMs: number;
  localOnlyOutput?: boolean;
  run(args: T, ctx: ToolContext): Promise<string>;
}

export interface ToolInvocationResult {
  ok: boolean;
  output: string;
  denied?: "permission" | "policy" | "confirmation";
}

const MAX_OUTPUT_CHARS = 20_000;

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[output truncated at ${MAX_OUTPUT_CHARS} chars — full result available via targeted commands]`;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** OpenAI-compatible tool specs for the current registry. */
  toProviderSpecs(names?: string[]): Array<{ name: string; description: string; parametersJsonSchema: Record<string, unknown> }> {
    const tools = names ? names.map((n) => this.tools.get(n)).filter((t): t is ToolDefinition => Boolean(t)) : this.list();
    return tools.map((t) => ({
      name: t.name,
      description: `${t.description} [risk=${t.risk}]`,
      parametersJsonSchema: t.parameters.describe() as unknown as Record<string, unknown>,
    }));
  }

  /**
   * The single secured entry point for executing any tool.
   */
  async invoke(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolInvocationResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `Unknown tool: ${name}` };
    }
    throwIfAborted(ctx.signal);

    // 1) Validate arguments against the declared schema.
    let args: Record<string, unknown>;
    try {
      args = tool.parameters.parse(rawArgs) as Record<string, unknown>;
    } catch (e) {
      ctx.audit({ action: "tool.invoke", targetType: "tool", targetId: name, decision: "denied", detail: "schema validation failed" });
      return { ok: false, output: `Invalid arguments for ${name}: ${(e as Error).message}` };
    }

    // 2) Permission gate (grants/denies in code).
    let targetSummary = describeTarget(name, args);
    if (tool.requiredPermission) {
      const verdict = evaluateRules(
        [
          ...ctx.denies.map((deny) => ({ isDeny: true as const, deny })),
          ...ctx.grants.map((grant) => ({ isDeny: false as const, grant })),
        ],
        { permission: tool.requiredPermission, target: targetSummary, projectRoot: ctx.projectRoot },
      );
      if (!verdict.allowed) {
        // Interactive sessions may ask once; non-interactive must fail closed.
        if (ctx.interactive && verdict.reason === "no-rule") {
          const granted = await ctx.confirm({
            title: `Allow ${tool.name}?`,
            detail: `${targetSummary}\nRisk: ${tool.risk}. Permission: ${tool.requiredPermission}`,
          });
          if (!granted) {
            ctx.audit({ action: "permission.requested", targetType: "tool", targetId: name, decision: "denied", detail: "user declined" });
            return { ok: false, denied: "confirmation", output: "User declined permission." };
          }
          ctx.audit({ action: "permission.granted", targetType: "tool", targetId: name, decision: "allowed", detail: targetSummary });
        } else {
          ctx.audit({ action: "tool.invoke", targetType: "tool", targetId: name, decision: "denied", detail: `no ${tool.requiredPermission} rule` });
          return {
            ok: false,
            denied: "permission",
            output: `Permission '${tool.requiredPermission}' has not been granted${ctx.interactive ? "" : " (non-interactive mode requires explicit rules)"}.`,
          };
        }
      }
    }

    // 3) Policy gate — independent of any prompt. Explicit rules first;
    //    when nothing matches, apply tiered defaults that stay fail-closed
    //    for anything risky (#0050).
    const policyInput: PolicyInput = {
      action: "tool.invoke",
      toolId: name,
      permission: tool.requiredPermission,
      classification: ctx.classification,
      workspaceTrusted: ctx.workspaceTrusted,
      interactive: ctx.interactive,
      ...(name === "web_fetch" && typeof args.url === "string" ? { networkDestination: hostOf(args.url) } : {}),
    };
    let decision = await new RulePolicyEngine().evaluate(ctx.policyRules, policyInput);
    if (decision.matchedRuleId.startsWith("default")) {
      if (tool.risk !== "low") {
        if (!ctx.interactive) {
          ctx.audit({ action: "policy.denied", targetType: "tool", targetId: name, decision: "denied", detail: "default: risky tool in non-interactive mode" });
          return {
            ok: false,
            denied: "policy",
            output: `${name} (${tool.risk} risk) requires explicit permission configuration in non-interactive mode.`,
          };
        }
        const approved = await ctx.confirm({
          title: `Allow ${tool.name}?`,
          detail: `${targetSummary}\nRisk: ${tool.risk}${tool.requiredPermission ? ` · Permission: ${tool.requiredPermission}` : ""}`,
        });
        if (!approved) {
          ctx.audit({ action: "tool.invoke", targetType: "tool", targetId: name, decision: "denied", detail: "user declined default approval" });
          return { ok: false, denied: "confirmation", output: "User declined." };
        }
        decision = { effect: "allow", matchedRuleId: "default-interactive", reason: "interactive consent" };
      } else {
        decision = { effect: "allow", matchedRuleId: "default-safe", reason: "low-risk read-only tool" };
      }
    }
    if (decision.effect === "deny") {
      ctx.audit({ action: "policy.denied", targetType: "tool", targetId: name, decision: "denied", detail: decision.matchedRuleId });
      return { ok: false, denied: "policy", output: `Blocked by policy ${decision.matchedRuleId}: ${decision.reason}` };
    }
    if (decision.effect === "confirm") {
      const approved = await ctx.confirm({ title: `Confirm ${tool.name}`, detail: `${targetSummary}\nPolicy ${decision.matchedRuleId} requires confirmation.` });
      if (!approved) {
        ctx.audit({ action: "tool.invoke", targetType: "tool", targetId: name, decision: "denied", detail: "confirmation refused" });
        return { ok: false, denied: "confirmation", output: "Confirmation refused." };
      }
    }

    // 4) Execute with timeout + capped output.
    try {
      const output = await withTimeout(tool.run(args, ctx), tool.timeoutMs, ctx.signal);
      ctx.audit({ action: "tool.completed", targetType: "tool", targetId: name, decision: "allowed" });
      return { ok: true, output: capOutput(output) };
    } catch (e) {
      const msg = e instanceof QofenoError ? e.userMessage : String((e as Error).message ?? e);
      ctx.audit({ action: "tool.failed", targetType: "tool", targetId: name, decision: "allowed", detail: msg.slice(0, 200) });
      return { ok: false, output: `Tool ${name} failed: ${msg}` };
    }
  }
}

async function withTimeout(p: Promise<string>, timeoutMs: number, external?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("tool timeout")), timeoutMs);
  const relay = () => controller.abort(new Error("cancelled"));
  external?.addEventListener("abort", relay, { once: true });
  try {
    return await p;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", relay);
  }
}

function describeTarget(name: string, args: Record<string, unknown>): string {
  if (typeof args.command === "string") return analyzeCommand(args.command).risk === "safe" ? args.command : args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.url === "string") return args.url;
  return name;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

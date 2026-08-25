/**
 * Agent runtime (#0052-#0057): a genuine bounded plan→act→observe loop.
 * Every tool call flows through ToolRegistry gates; budgets, steps and
 * timeouts are hard limits; activity summaries are user-facing only
 * (no hidden chain-of-thought is exposed).
 */
import { ErrorCode, EventBus, QofenoError, envelope, linkedSignal, type AiProvider, type ChatMessage, type ChatRequest } from "@agent-qofeno/core";
import type { ToolRegistry, ToolContext } from "@agent-qofeno/tools";
import type { ContextManager } from "@agent-qofeno/ctx";

export interface AgentRunOptions {
  goal: string;
  systemPrompt?: string;
  modelId: string;
  allowedTools?: string[];
  maxSteps?: number;
  timeoutMs?: number;
  /** Rough USD ceiling; usage-based estimates stop the run when exceeded. */
  budgetUsd?: number;
  interactive?: boolean;
}

export interface AgentStepRecord {
  step: number;
  action: string;
  detail: string;
  atMs: number;
}

export interface AgentRunResult {
  status: "completed" | "failed" | "cancelled" | "max_steps" | "budget_exceeded";
  answer: string;
  steps: AgentStepRecord[];
  toolCalls: number;
  elapsedMs: number;
}

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_TIMEOUT_MS = 300_000;

/** Conservative token→USD mapping used only for budget guardrails. */
function estimateCostUsd(usage: { inputTokens?: number; outputTokens?: number }): number {
  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;
  return ((inTok * 3 + outTok * 15) / 1_000_000) * 1; // $3/M in, $15/M out upper bound
}

export class AgentRuntime {
  constructor(
    private readonly provider: AiProvider,
    private readonly registry: ToolRegistry,
    private readonly context: ContextManager,
    private readonly events: EventBus = new EventBus(),
  ) {}

  async run(opts: AgentRunOptions, toolCtx: ToolContext): Promise<AgentRunResult> {
    const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    const { signal, cancel } = linkedSignal(toolCtx.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const startedAt = Date.now();
    const steps: AgentStepRecord[] = [];
    let toolCalls = 0;
    let spentUsd = 0;

    const record = (action: string, detail: string) => {
      steps.push({ step: steps.length + 1, action, detail, atMs: Date.now() });
      this.events.publish(envelope("agent.activity", { summary: `${action}: ${detail}`.slice(0, 200) }));
    };

    this.events.publish(envelope("agent.started", { goal: opts.goal.slice(0, 200) }));

    try {
      const messages: ChatMessage[] = [];
      const assembled = this.context.assemble({
        systemPrompt:
          (opts.systemPrompt ?? "You are Qofeno, a careful terminal coding agent.") +
          "\nWork toward the goal using the provided tools. Stop as soon as the goal is achieved.",
        history: [{ role: "user", content: `Goal: ${opts.goal}` }],
      });
      messages.push(...assembled.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage));

      const specs = this.registry.toProviderSpecs(opts.allowedTools);

      for (let step = 0; step < maxSteps; step++) {
        if (signal.aborted) throw new QofenoError({ code: ErrorCode.CANCELLED, message: "agent cancelled" });

        const request: ChatRequest = {
          model: opts.modelId,
          messages,
          ...(specs.length ? { tools: specs } : {}),
          signal,
        };
        const textParts: string[] = [];
        const pendingCalls: Array<{ id: string; name: string; argsJson: string }> = [];

        for await (const chunk of this.provider.chat(request)) {
          if (chunk.type === "delta") textParts.push(chunk.text);
          else if (chunk.type === "tool_call") pendingCalls.push(chunk.call);
          else if (chunk.type === "usage") {
            spentUsd += estimateCostUsd(chunk.usage);
            if (opts.budgetUsd !== undefined && spentUsd > opts.budgetUsd) {
              return this.finish("budget_exceeded", `Stopped: estimated spend $${spentUsd.toFixed(4)} exceeded budget $${opts.budgetUsd}.`, steps, toolCalls, startedAt);
            }
          } else if (chunk.type === "error") {
            throw new QofenoError({
              code: ErrorCode.PROVIDER_ERROR,
              message: chunk.message,
              userMessage: "The model returned an error mid-run. Partial work is preserved.",
              retryable: chunk.retryable,
            });
          }
        }

        const assistantText = textParts.join("");

        if (pendingCalls.length === 0) {
          record("respond", assistantText.slice(0, 120) || "(no text)");
          return this.finish("completed", assistantText, steps, toolCalls, startedAt);
        }

        messages.push({
          role: "assistant",
          content: assistantText,
          toolCalls: pendingCalls.map((c) => ({ id: c.id, name: c.name, argsJson: c.argsJson })),
        });

        for (const call of pendingCalls) {
          if (signal.aborted) break;
          record("tool", `${call.name} ${call.argsJson.slice(0, 80)}`);
          const result = await this.registry.invoke(call.name, safeJson(call.argsJson), toolCtx);
          toolCalls++;
          record(result.ok ? "result" : "tool-error", result.output.slice(0, 140));
          messages.push({ role: "tool", content: result.output, toolCallId: call.id });
        }
      }

      return this.finish("max_steps", `Reached the ${maxSteps}-step limit. Progress so far is preserved.`, steps, toolCalls, startedAt);
    } catch (e) {
      const cancelled = (e as QofenoError).code === ErrorCode.CANCELLED || signal.aborted;
      this.events.publish(envelope(cancelled ? "agent.failed" : "agent.failed", { error: String((e as Error).message ?? e).slice(0, 200) }));
      return {
        status: cancelled ? "cancelled" : "failed",
        answer: e instanceof QofenoError ? e.userMessage : String((e as Error).message ?? e),
        steps,
        toolCalls,
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      cancel();
    }
  }

  private finish(status: AgentRunResult["status"], answer: string, steps: AgentStepRecord[], toolCalls: number, startedAt: number): AgentRunResult {
    this.events.publish(envelope(status === "completed" ? "agent.completed" : "agent.failed", { status }));
    return { status, answer, steps, toolCalls, elapsedMs: Date.now() - startedAt };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Multi-agent task queue (#0055/#0056): bounded-concurrency execution of
 * independent goals with isolated contexts. Agents cannot escalate each
 * other's permissions — every run receives its own ToolContext.
 */
export class AgentTaskQueue {
  private queue: Array<() => Promise<void>> = [];
  private active = 0;

  constructor(private readonly concurrency = 2) {}

  submit(task: () => Promise<void>): void {
    this.queue.push(task);
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const t = this.queue.shift()!;
      this.active++;
      void t().finally(() => {
        this.active--;
        this.drain();
      });
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  get running(): number {
    return this.active;
  }
}

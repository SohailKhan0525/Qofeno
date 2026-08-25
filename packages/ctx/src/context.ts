/**
 * Context manager (#0015/#0016/#0173): assemble the model context from
 * authorized sources only, under a token budget, with source tracking and
 * deterministic compaction.
 */
import type { MessageRow } from "@agent-qofeno/core";
import type { MemoryRecord, RetrievedChunk } from "@agent-qofeno/core";

export interface ContextSource {
  kind: "system" | "project-instructions" | "memory" | "knowledge" | "history" | "tool";
  label: string;
  content: string;
}

export interface AssembledContext {
  messages: Array<Pick<MessageRow, "role" | "content">>;
  budgetUsed: number;
  dropped: string[];
  sources: ContextSource[];
}

export function estimateTokens(text: string): number {
  // Fast heuristic (~4 chars/token) — documented in docs/architecture.md.
  return Math.ceil(text.length / 4);
}

export class ContextManager {
  constructor(private readonly tokenBudget: number = 100_000) {}

  /**
   * Assemble in priority order (system → project → memories → history tail).
   * When the budget is exceeded, older history is compacted away FIRST;
   * system/project instructions are never silently dropped (#0016).
   */
  assemble(input: {
    systemPrompt?: string;
    projectInstructions?: string | null;
    memories?: MemoryRecord[];
    knowledge?: RetrievedChunk[];
    history: Array<Pick<MessageRow, "role" | "content">>;
    maxHistoryTurns?: number;
  }): AssembledContext {
    const dropped: string[] = [];
    const sources: ContextSource[] = [];

    let budget = this.tokenBudget;
    const spend = (text: string) => {
      const t = estimateTokens(text);
      budget -= t;
      return t;
    };

    const headMessages: Array<{ role: MessageRow["role"]; content: string }> = [];
    if (input.systemPrompt) {
      headMessages.push({ role: "system", content: input.systemPrompt });
      sources.push({ kind: "system", label: "system prompt", content: input.systemPrompt });
    }
    if (input.projectInstructions) {
      headMessages.push({ role: "system", content: `[Project instructions]\n${input.projectInstructions}` });
      sources.push({ kind: "project-instructions", label: "project instructions", content: input.projectInstructions });
    }
    let spent = headMessages.reduce((n, m) => n + estimateTokens(m.content), 0);
    budget -= spent;

    if (input.memories?.length) {
      const memBlock = input.memories.map((m) => `- ${m.content}`).join("\n");
      if (estimateTokens(memBlock) <= budget) {
        headMessages.push({ role: "system", content: `[Active memory]\n${memBlock}` });
        sources.push({ kind: "memory", label: `${input.memories.length} memories`, content: memBlock });
        budget -= estimateTokens(memBlock);
      } else {
        dropped.push(`memories (${input.memories.length}) exceeded budget`);
      }
    }

    if (input.knowledge?.length) {
      const kb = input.knowledge
        .map((r, i) => `[${i + 1}] ${r.sourceTitle}:\n${r.chunk.text}`)
        .join("\n\n");
      if (estimateTokens(kb) <= budget) {
        headMessages.push({ role: "system", content: `[Retrieved knowledge]\n${kb}` });
        sources.push({
          kind: "knowledge",
          label: input.knowledge.map((k) => k.sourceTitle).join(", "),
          content: kb,
        });
        budget -= estimateTokens(kb);
      } else {
        dropped.push("retrieved knowledge exceeded budget");
      }
    }

    // History from the newest end; stop when out of budget/turns.
    const turns = Math.max(2, input.maxHistoryTurns ?? 40);
    const picked: Array<{ role: MessageRow["role"]; content: string }> = [];
    for (let i = input.history.length - 1; i >= 0 && picked.length < turns; i--) {
      const m = input.history[i]!;
      const t = estimateTokens(m.content);
      if (t > budget) {
        if (picked.length === 0) continue; // skip oversized old turns entirely
        dropped.push(`${input.history.length - i} older messages exceeded budget`);
        break;
      }
      if (budget - t < 0) {
        dropped.push(`${i} oldest messages exceeded budget`);
        break;
      }
      picked.unshift(m);
      budget -= t;
    }

    const messages = [...headMessages, ...picked];
    const used = messages.reduce((n, m) => n + estimateTokens(m.content), 0);
    return { messages, budgetUsed: used, dropped, sources };
    void spent;
  }
}
